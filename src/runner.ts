import { MetricsCollector } from '@agentionai/agents';
import { EvalDataset } from './dataset';
import {
  EvalCase,
  EvalCaseResult,
  EvalFailConditions,
  EvalReport,
  EvalTarget,
  IScorer,
  RankCaseResult,
  RankReport,
  RefineReport,
  ScorerContext,
  ToolCall,
} from './types';

export class EvalThresholdError<TInput = string> extends Error {
  readonly report: EvalReport<TInput>;
  readonly violations: string[];

  constructor(violations: string[], report: EvalReport<TInput>) {
    super(`Eval thresholds violated:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
    this.name = 'EvalThresholdError';
    this.report = report;
    this.violations = violations;
  }
}

export interface EvalRunnerOptions<TInput = string> {
  target: EvalTarget<TInput>;
  dataset: EvalDataset<TInput>;
  scorers: IScorer<TInput>[];
  concurrency?: number;
  metrics?: MetricsCollector;
  failIf?: EvalFailConditions;
  onCaseComplete?: (result: EvalCaseResult<TInput>, index: number) => void;
}

class Semaphore {
  private slots: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.slots = limit;
  }

  acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.slots++;
    }
  }
}

function tokenSnapshot(metrics: MetricsCollector) {
  const agg = metrics.getAggregateMetrics();
  return {
    input: agg.totalTokens.inputTokens,
    output: agg.totalTokens.outputTokens,
    total: agg.totalTokens.totalTokens,
  };
}

// Agention agents record tool calls as `tool_use` content blocks in their
// history. Read them duck-typed after execute() so any target exposing
// getHistoryEntries() yields its tool-call trace, without coupling to the
// peer dep's types. With transient history (the default) the entries hold just
// the current turn; with shared history, prefer concurrency: 1 for clean
// per-case attribution.
function readToolCalls(target: unknown): ToolCall[] {
  const getEntries = (target as { getHistoryEntries?: () => unknown }).getHistoryEntries;
  if (typeof getEntries !== 'function') return [];

  let entries: unknown;
  try {
    entries = getEntries.call(target);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];

  const calls: ToolCall[] = [];
  for (const entry of entries) {
    const content = (entry as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; id?: string; name?: string; input?: unknown };
      if (b?.type === 'tool_use' && typeof b.name === 'string') {
        calls.push({
          name: b.name,
          input: (b.input as Record<string, unknown>) ?? {},
          id: b.id,
        });
      }
    }
  }
  return calls;
}

// Agention agents expose per-call token usage directly on the instance after
// execute() — no metrics collector required. Read it duck-typed so any target
// that reports usage this way (Claude/OpenAI/Mistral/Gemini/Ollama) is covered.
function readAgentTokenUsage(
  target: unknown
): { input: number; output: number; total: number } | undefined {
  const usage = (
    target as {
      lastTokenUsage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    }
  ).lastTokenUsage;
  if (!usage || typeof usage.total_tokens !== 'number') return undefined;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    total: usage.total_tokens,
  };
}

export class EvalRunner<TInput = string> {
  private readonly options: EvalRunnerOptions<TInput>;

  constructor(options: EvalRunnerOptions<TInput>) {
    this.options = options;
  }

  async run(): Promise<EvalReport<TInput>> {
    const { target, dataset, scorers, concurrency = 1, metrics, onCaseComplete } = this.options;
    const semaphore = new Semaphore(concurrency);
    const results: EvalCaseResult<TInput>[] = new Array(dataset.size);
    const startTime = Date.now();

    await Promise.all(
      dataset.cases.map(async (evalCase, index) => {
        await semaphore.acquire();
        try {
          results[index] = await runCase(evalCase, index, target, scorers, metrics);
          onCaseComplete?.(results[index], index);
        } finally {
          semaphore.release();
        }
      })
    );

    const report = buildReport(results, Date.now() - startTime);

    if (this.options.failIf) {
      const violations = checkThresholds(report, this.options.failIf);
      if (violations.length > 0) throw new EvalThresholdError(violations, report);
    }

    return report;
  }

  // Runs each target independently and always returns every report — it does
  // not accept failIf, since aborting mid-comparison would discard the other
  // targets' results. Gate on thresholds per-target after compare() returns.
  static async compare<TInput = string>(
    dataset: EvalDataset<TInput>,
    scorers: IScorer<TInput>[],
    targets: Record<string, EvalTarget<TInput>>,
    options: { concurrency?: number } = {}
  ): Promise<Record<string, EvalReport<TInput>>> {
    const entries = await Promise.all(
      Object.entries(targets).map(async ([name, target]) => {
        const runner = new EvalRunner({ target, dataset, scorers, concurrency: options.concurrency });
        const report = await runner.run();
        return [name, report] as const;
      })
    );
    return Object.fromEntries(entries);
  }

  // Comparative ("arena") evaluation: for each case, run every target, then ask
  // a single judge to rank their outputs against each other. Far more
  // discriminating than independent pointwise scoring (Scorer.llm), which
  // saturates — an easy task scores every output 5/5, so absolute scores can't
  // separate good prompts from great ones. Returns a leaderboard aggregated
  // across all cases. Requires at least two targets.
  static async rank<TInput = string>(options: {
    dataset: EvalDataset<TInput>;
    targets: Record<string, EvalTarget<TInput>>;
    judge: EvalTarget;
    criteria: string;
    concurrency?: number;
  }): Promise<RankReport<TInput>> {
    const { dataset, targets, judge, criteria, concurrency = 1 } = options;
    const names = Object.keys(targets);
    if (names.length < 2) {
      throw new Error('EvalRunner.rank requires at least two targets to compare.');
    }

    const semaphore = new Semaphore(concurrency);
    const caseResults: RankCaseResult<TInput>[] = new Array(dataset.size);

    await Promise.all(
      dataset.cases.map(async (evalCase, index) => {
        await semaphore.acquire();
        try {
          caseResults[index] = await rankCase(evalCase, names, targets, judge, criteria);
        } finally {
          semaphore.release();
        }
      })
    );

    return buildRankReport(caseResults, names);
  }

  // For each case, generates beamWidth candidate outputs per round, selects the
  // best-scoring one, then optionally transforms the input (via buildInput) so
  // the next round can build on the previous best. Returns per-round reports and
  // an improvement delta so you can see whether iteration actually helped.
  static async refine<TInput = string>(options: {
    dataset: EvalDataset<TInput>;
    // Single target used for all beam slots, or an array that cycles across
    // slots (e.g. three agents with temperatures 0.3 / 0.7 / 1.0).
    target: EvalTarget<TInput> | EvalTarget<TInput>[];
    scorers: IScorer<TInput>[];
    rounds: number;
    beamWidth: number;
    // Receives the current-round input + all beamWidth candidates sorted best-first.
    // Return the input to use for the next round. Omit for pure best-of-N sampling.
    buildInput?: (current: TInput, candidatesByScore: string[]) => TInput;
    // Optionally rephrase the input differently for each beam slot (0-indexed).
    // Applied after buildInput, so it operates on the current round's input.
    buildBeamInput?: (input: TInput, beamIndex: number, round: number) => TInput;
    // Gates concurrent cases. Beam candidates within a single case always run in
    // parallel — effective simultaneous requests = concurrency × beamWidth.
    concurrency?: number;
    onRoundComplete?: (round: number, report: EvalReport<TInput>) => void;
  }): Promise<RefineReport<TInput>> {
    const { dataset, scorers, rounds, beamWidth, buildInput, buildBeamInput, concurrency = 1, onRoundComplete } = options;

    if (rounds < 1) throw new Error('EvalRunner.refine requires rounds >= 1');
    if (beamWidth < 1) throw new Error('EvalRunner.refine requires beamWidth >= 1');

    // Normalize to array so all slots use the same cycling logic.
    const targetArray = Array.isArray(options.target) ? options.target : [options.target];
    const semaphore = new Semaphore(concurrency);
    const currentInputs = dataset.cases.map((c) => c.input);
    const roundReports: EvalReport<TInput>[] = [];

    for (let round = 0; round < rounds; round++) {
      const roundResults: EvalCaseResult<TInput>[] = new Array(dataset.size);
      const roundStart = Date.now();

      await Promise.all(
        dataset.cases.map(async (evalCase, index) => {
          await semaphore.acquire();
          try {
            const input = currentInputs[index];
            const caseStart = Date.now();

            // Generate beamWidth candidates in parallel, each with its own
            // target slot (cycling if fewer targets than beamWidth) and its
            // own optionally-rephrased input.
            const beamOutputs = await Promise.all(
              Array.from({ length: beamWidth }, async (_, i) => {
                const beamTarget = targetArray[i % targetArray.length];
                const beamInput = buildBeamInput ? buildBeamInput(input, i, round) : input;
                try {
                  const raw = await beamTarget.execute(beamInput);
                  const output = typeof raw === 'string' ? raw : raw.toString();
                  return {
                    output,
                    toolCalls: readToolCalls(beamTarget),
                    tokens: readAgentTokenUsage(beamTarget),
                  };
                } catch (err) {
                  return {
                    output: `<<error: ${err instanceof Error ? err.message : String(err)}>>`,
                    toolCalls: [] as ToolCall[],
                    tokens: undefined,
                  };
                }
              }),
            );

            // Score each candidate, passing its tool-call trace as context
            const scored = await Promise.all(
              beamOutputs.map(async (beam) => {
                const context: ScorerContext = { toolCalls: beam.toolCalls };
                const scores = await Promise.all(
                  scorers.map((s) =>
                    s.score(beam.output, evalCase.expected, input, context).catch((err) => ({
                      pass: false,
                      score: 0,
                      reason: `Scorer error: ${err instanceof Error ? err.message : String(err)}`,
                      scorerName: s.name,
                    })),
                  ),
                );
                const meanScore =
                  scores.length > 0
                    ? scores.reduce((a, s) => a + s.score, 0) / scores.length
                    : 0;
                return { ...beam, scores, meanScore };
              }),
            );

            // Sort best-first so buildInput always gets candidates[0] = best
            scored.sort((a, b) => b.meanScore - a.meanScore);
            const best = scored[0];

            roundResults[index] = {
              case: evalCase,
              output: best.output,
              scores: best.scores,
              pass: best.scores.every((s) => s.pass),
              durationMs: Date.now() - caseStart,
              tokens: best.tokens,
              toolCalls: best.toolCalls,
            };

            if (buildInput) {
              // Pass the current-round evolved input (not the original dataset input)
              // so multi-round chains can layer refinements across rounds.
              currentInputs[index] = buildInput(
                input,
                scored.map((c) => c.output),
              );
            }
          } finally {
            semaphore.release();
          }
        }),
      );

      const report = buildReport(roundResults, Date.now() - roundStart);
      roundReports.push(report);
      onRoundComplete?.(round, report);
    }

    const final = roundReports[roundReports.length - 1];
    const improvement =
      roundReports.length > 1 ? final.passRate - roundReports[0].passRate : 0;
    return { rounds: roundReports, final, improvement };
  }
}

async function runCase<TInput>(
  evalCase: { input: TInput; expected?: unknown },
  index: number,
  target: EvalTarget<TInput>,
  scorers: IScorer<TInput>[],
  metrics?: MetricsCollector
): Promise<EvalCaseResult<TInput>> {
  const tokensBefore = metrics ? tokenSnapshot(metrics) : undefined;
  const start = Date.now();
  let output: string;

  try {
    const raw = await target.execute(evalCase.input);
    output = typeof raw === 'string' ? raw : raw.toString();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedScores = scorers.map((s) => ({
      pass: false,
      score: 0,
      reason: `Target threw: ${errMsg}`,
      scorerName: s.name,
    }));
    return {
      case: evalCase,
      output: '',
      scores: failedScores,
      pass: false,
      durationMs: Date.now() - start,
      tokens: undefined,
      toolCalls: [],
    };
  }

  const toolCalls = readToolCalls(target);
  const context = { toolCalls };

  const scores = await Promise.all(
    scorers.map((s) => s.score(output, evalCase.expected, evalCase.input, context).catch((err) => ({
      pass: false,
      score: 0,
      reason: `Scorer error: ${err instanceof Error ? err.message : String(err)}`,
      scorerName: s.name,
    })))
  );

  const tokensAfter = metrics ? tokenSnapshot(metrics) : undefined;
  const metricsDelta =
    tokensBefore && tokensAfter
      ? {
          input: tokensAfter.input - tokensBefore.input,
          output: tokensAfter.output - tokensBefore.output,
          total: tokensAfter.total - tokensBefore.total,
        }
      : undefined;

  // Prefer the agent's own per-call usage (works without a collector); fall back
  // to the collector delta for composite graph targets that report through it.
  const tokens = readAgentTokenUsage(target) ?? metricsDelta;
  const durationMs = Date.now() - start;
  const tokensPerSecond =
    tokens && durationMs > 0 ? tokens.total / (durationMs / 1000) : undefined;

  return {
    case: evalCase,
    output,
    scores,
    pass: scores.every((s) => s.pass),
    durationMs,
    tokens,
    tokensPerSecond,
    toolCalls,
  };
}

function checkThresholds(report: EvalReport<unknown>, failIf: EvalFailConditions): string[] {
  const violations: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  if (failIf.passRate) {
    const { lt, lte } = failIf.passRate;
    if (lt !== undefined && report.passRate < lt) {
      violations.push(`passRate ${pct(report.passRate)} < ${pct(lt)}`);
    }
    if (lte !== undefined && report.passRate <= lte) {
      violations.push(`passRate ${pct(report.passRate)} <= ${pct(lte)}`);
    }
  }

  for (const [scorerName, threshold] of Object.entries(failIf.scores ?? {})) {
    const mean = report.scores[scorerName];
    if (mean === undefined) continue;
    const { lt, lte } = threshold;
    if (lt !== undefined && mean < lt) {
      violations.push(`${scorerName} mean score ${mean.toFixed(3)} < ${lt}`);
    }
    if (lte !== undefined && mean <= lte) {
      violations.push(`${scorerName} mean score ${mean.toFixed(3)} <= ${lte}`);
    }
  }

  return violations;
}

function buildReport<TInput>(
  cases: EvalCaseResult<TInput>[],
  durationMs: number
): EvalReport<TInput> {
  const passed = cases.filter((c) => c.pass).length;
  const totalTokens = cases.reduce((sum, c) => sum + (c.tokens?.total ?? 0), 0);
  const tpsValues = cases
    .map((c) => c.tokensPerSecond)
    .filter((v): v is number => v !== undefined);
  const meanTps =
    tpsValues.length > 0 ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length : 0;

  // Collect mean score per scorer
  const scorerAccum: Record<string, { sum: number; count: number }> = {};
  for (const c of cases) {
    for (const s of c.scores) {
      if (!scorerAccum[s.scorerName]) scorerAccum[s.scorerName] = { sum: 0, count: 0 };
      scorerAccum[s.scorerName].sum += s.score;
      scorerAccum[s.scorerName].count += 1;
    }
  }
  const scores: Record<string, number> = {};
  for (const [name, { sum, count }] of Object.entries(scorerAccum)) {
    scores[name] = count > 0 ? sum / count : 0;
  }

  return {
    passed,
    failed: cases.length - passed,
    total: cases.length,
    passRate: cases.length > 0 ? passed / cases.length : 0,
    scores,
    tokenCost: {
      total: totalTokens,
      perCase: cases.length > 0 ? totalTokens / cases.length : 0,
      perSecond: meanTps,
    },
    durationMs,
    cases,
  };
}

// --- Comparative ranking helpers ---

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function parseJudgeJson(raw: string): Record<string, unknown> | undefined {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function rankCase<TInput>(
  evalCase: EvalCase<TInput>,
  names: string[],
  targets: Record<string, EvalTarget<TInput>>,
  judge: EvalTarget,
  criteria: string
): Promise<RankCaseResult<TInput>> {
  // Run every target on this case.
  const outputs: Record<string, string> = {};
  await Promise.all(
    names.map(async (name) => {
      try {
        const raw = await targets[name].execute(evalCase.input);
        outputs[name] = typeof raw === 'string' ? raw : raw.toString();
      } catch (err) {
        outputs[name] = `<<target errored: ${err instanceof Error ? err.message : String(err)}>>`;
      }
    })
  );

  // Anonymise + shuffle so the judge can't anchor on target names or position.
  const order = shuffle(names);
  const labels = order.map((_, i) => String.fromCharCode(65 + i)); // A, B, C, ...
  const labelToName = new Map(labels.map((l, i) => [l, order[i]]));

  const promptLines = [
    'You are comparing AI outputs produced for the same task.',
    'Rank them from best to worst by how well they satisfy the criteria.',
    '',
    `Criteria: ${criteria}`,
    '',
    `Input: ${JSON.stringify(evalCase.input)}`,
  ];
  if (evalCase.expected !== undefined) {
    promptLines.push(`Reference: ${JSON.stringify(evalCase.expected)}`);
  }
  promptLines.push('', 'Candidates:');
  order.forEach((name, i) => promptLines.push('', `[${labels[i]}]`, outputs[name]));
  promptLines.push(
    '',
    'Respond with JSON only, no other text:',
    '{"ranking": ["<label>", ...], "reason": "<brief explanation>"}',
    `The "ranking" array must list every label (${labels.join(', ')}) exactly once, best first.`
  );
  const prompt = promptLines.join('\n');

  let raw: string;
  try {
    const res = await judge.execute(prompt as never);
    raw = typeof res === 'string' ? res : res.toString();
  } catch (err) {
    return { case: evalCase, outputs, ranking: [], reason: `Judge error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = parseJudgeJson(raw);
  const rawRanking = parsed?.ranking;
  const reason = typeof parsed?.reason === 'string' ? (parsed.reason as string) : undefined;

  // Validate: the ranking must be a permutation of the labels.
  if (
    !Array.isArray(rawRanking) ||
    rawRanking.length !== labels.length ||
    new Set(rawRanking).size !== labels.length ||
    !rawRanking.every((l) => labelToName.has(l as string))
  ) {
    return { case: evalCase, outputs, ranking: [], reason: reason ?? `Could not parse judge ranking: ${raw}` };
  }

  const ranking = (rawRanking as string[]).map((l) => labelToName.get(l) as string);
  return { case: evalCase, outputs, ranking, reason };
}

function buildRankReport<TInput>(
  cases: RankCaseResult<TInput>[],
  names: string[]
): RankReport<TInput> {
  const stats = new Map(names.map((n) => [n, { wins: 0, points: 0, rankSum: 0, ranked: 0 }]));

  for (const c of cases) {
    const n = c.ranking.length;
    c.ranking.forEach((name, pos) => {
      const s = stats.get(name);
      if (!s) return;
      s.points += n - 1 - pos; // Borda count
      s.rankSum += pos + 1;
      s.ranked += 1;
      if (pos === 0) s.wins += 1;
    });
  }

  const leaderboard = names
    .map((name) => {
      const s = stats.get(name)!;
      return {
        name,
        wins: s.wins,
        points: s.points,
        averageRank: s.ranked > 0 ? s.rankSum / s.ranked : NaN,
      };
    })
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.averageRank - b.averageRank);

  return { leaderboard, cases };
}
