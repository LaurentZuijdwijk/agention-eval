import { MetricsCollector } from '@agentionai/agents';
import { EvalDataset } from './dataset';
import { EvalCaseResult, EvalFailConditions, EvalReport, EvalTarget, IScorer } from './types';

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
    };
  }

  const scores = await Promise.all(
    scorers.map((s) => s.score(output, evalCase.expected, evalCase.input).catch((err) => ({
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

  return {
    case: evalCase,
    output,
    scores,
    pass: scores.every((s) => s.pass),
    durationMs: Date.now() - start,
    tokens,
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
    },
    durationMs,
    cases,
  };
}
