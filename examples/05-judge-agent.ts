/**
 * Judge agent example — evaluating open-ended output with Scorer.llm().
 *
 * Deterministic scorers (fieldAccuracy, jsonSchema) work well when output
 * is structured. For open-ended text — summaries, explanations, tone —
 * a judge agent is the right tool.
 *
 * This example evaluates a summarisation pipeline with two complementary
 * scorers running in parallel:
 *
 *   Scorer.custom — fast, zero-cost: cheap structural guard (length bounds)
 *   Scorer.llm    — semantic: judge rates faithfulness on a 1–5 scale
 *
 * The `expected` field is a plain string describing what the summary should
 * cover. The judge receives both `expected` and `output` in its prompt, so
 * it can compare them directly against the stated criteria.
 *
 * The judge's `reason` is attached to each ScorerResult, making failures
 * self-explanatory in the report.
 */
import { ClaudeAgent } from '@agentionai/agents';
import { EvalDataset, EvalRunner, EvalThresholdError, Scorer, formatReport } from '../src';

const summariser = new ClaudeAgent({
  id: 'summariser',
  name: 'Summariser',
  description: [
    'Summarise the provided text in 1–2 sentences.',
    'Be concise and faithful to the source — do not add information.',
  ].join('\n'),
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
  temperature: 0.3,
});

// Judge temperature should be 0 — deterministic scoring prevents the judge's
// own variance from inflating or deflating scores across eval runs.
const judge = new ClaudeAgent({
  id: 'judge',
  name: 'Faithfulness Judge',
  description: 'You are a precise evaluation judge. Follow the scoring instructions exactly and return only JSON.',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
  temperature: 0,
});

// `expected` is the reference description the judge compares the output against.
const dataset = new EvalDataset([
  {
    input: `The James Webb Space Telescope (JWST) launched on 25 December 2021. It is the
largest optical telescope in space and observes in the infrared spectrum.
Its primary mirror is 6.5 metres in diameter, giving it a much larger
light-collecting area than its predecessor, the Hubble Space Telescope.`,
    expected: 'Should mention: JWST launched December 2021, observes in infrared, 6.5m primary mirror.',
    metadata: { topic: 'astronomy' },
  },
  {
    input: `Python was created by Guido van Rossum and first released in 1991. It emphasises
code readability and uses significant indentation. Python supports multiple
programming paradigms including procedural, object-oriented, and functional.`,
    expected: 'Should mention: creator Guido van Rossum, 1991 release, readability emphasis.',
    metadata: { topic: 'technology' },
  },
  {
    input: `The Mediterranean diet is based on the traditional foods of countries bordering
the Mediterranean Sea. It is rich in fruits, vegetables, whole grains, legumes,
nuts, and olive oil. Studies associate it with reduced risk of heart disease.`,
    expected: 'Should mention: Mediterranean origin, key food groups (olive oil, vegetables), heart disease benefit.',
    metadata: { topic: 'health' },
  },
]);

const runner = new EvalRunner({
  target: summariser,
  dataset,
  scorers: [
    // Fast, zero-cost guard that applies to every case regardless of topic:
    // a 1–2 sentence summary should be non-empty and shorter than its source.
    // Cheap structural checks like this catch gross failures before spending
    // judge tokens. (Keyword `contains` checks don't fit here — the dataset
    // spans multiple topics, so no single keyword set applies to all cases.)
    Scorer.custom('lengthGuard', async (output, _expected, input) => {
      const len = output.trim().length;
      const pass = len > 0 && len < String(input).length;
      return {
        pass,
        score: pass ? 1 : 0,
        reason: pass ? undefined : `summary length ${len} not within (0, ${String(input).length})`,
        scorerName: 'lengthGuard',
      };
    }),

    // Semantic check: judge rates how faithfully the summary covers the expected points.
    // The judge prompt includes `input`, `output`, and `expected`, so the `expected`
    // string is visible to the judge when it evaluates the output.
    Scorer.llm(judge, {
      criteria: 'Does the summary faithfully cover the key points described in the Expected field? Penalise omissions and hallucinations.',
      scale: 5,
      passingScore: 0.6, // 3 out of 5
    }),
  ],
  failIf: {
    scores: { llm: { lt: 0.6 } },
  },
  onCaseComplete(result, index) {
    const topic = result.case.metadata?.topic as string;
    const status = result.pass ? 'PASS' : 'FAIL';
    const llm = result.scores.find((s) => s.scorerName === 'llm');
    console.log(`  [${index + 1}] ${status}  [${topic}]  faithfulness: ${llm?.score.toFixed(2) ?? '—'}`);
    if (llm?.reason) console.log(`         reason: ${llm.reason}`);
  },
});

runner.run()
  .then((report) => {
    console.log(formatReport(report, { groupBy: 'topic' }));
  })
  .catch((err) => {
    if (err instanceof EvalThresholdError) {
      console.log(formatReport(err.report, { groupBy: 'topic' }));
      console.error('Threshold violations:');
      for (const v of err.violations) console.error(`  - ${v}`);
      process.exit(1);
    }
    throw err;
  });
