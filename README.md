# @agentionai/eval

Eval framework for AI agent pipelines built with [Agention](https://docs.agention.ai).

Unit tests can tell you whether your code runs. They can't tell you whether your invoice extractor handles edge cases across 500 real documents, whether Claude Haiku is accurate enough to replace Sonnet on your task, or whether a prompt change introduced a regression last Tuesday. `@agentionai/eval` fills that gap: run your agents and pipelines against representative datasets, score outputs with deterministic checks or a judge agent, and gate deploys on quality thresholds — all in TypeScript, no config files.

## Installation

```bash
npm install @agentionai/eval @agentionai/agents
```

## Quick start

Any Agention `Pipeline`, `AgentGraph`, `GraphNode`, or plain object with an `execute` method is a valid eval target.

```typescript
import { ClaudeAgent } from '@agentionai/agents';
import { EvalDataset, EvalRunner, EvalThresholdError, Scorer, formatReport } from '@agentionai/eval';

const agent = new ClaudeAgent({
  id: 'extractor',
  name: 'Extractor',
  description: 'Extract the invoice number and total. Return JSON: { invoice_no: string, total: number }',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
  temperature: 0.1,
});

const dataset = new EvalDataset([
  { input: 'Invoice INV-001. Total due: $1,250.00', expected: { invoice_no: 'INV-001', total: 1250 } },
  { input: 'Ref: INV-002. Amount: £890.50',         expected: { invoice_no: 'INV-002', total: 890.50 } },
]);

const runner = new EvalRunner({
  target: agent,
  dataset,
  scorers: [
    Scorer.fieldAccuracy(['invoice_no', 'total'], { tolerance: 0.01 }),
  ],
  failIf: { passRate: { lt: 0.9 } },
});

try {
  const report = await runner.run();
  console.log(formatReport(report));
} catch (err) {
  if (err instanceof EvalThresholdError) {
    console.log(formatReport(err.report));
    process.exit(1);
  }
}
```

## LLM-as-judge

Deterministic scorers can verify structure and field values, but they can't tell you whether an answer is accurate, a summary is faithful, or a response has the right tone. For that, use a judge agent.

`Scorer.llm()` sends the full context — `input`, `output`, `expected`, `criteria` — to a judge agent and asks it to return `{ score, reason }` JSON. The score is normalised to 0–1 and the `reason` surfaces in every report format, making failures self-explanatory.

```typescript
import { ClaudeAgent } from '@agentionai/agents';
import { Scorer } from '@agentionai/eval';

// Use a cheap model for the judge — it rarely needs deep reasoning.
// Temperature 0 is essential: judge variance would make cross-model
// comparisons meaningless.
const judge = new ClaudeAgent({
  id: 'judge',
  name: 'Judge',
  description: 'You are a precise evaluation judge. Return only JSON.',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
  temperature: 0,
});

Scorer.llm(judge, {
  criteria: 'Does the summary faithfully cover the key points in the Expected field? Penalise omissions and hallucinations.',
  scale: 5,          // score range 1–5, normalised to 0–1
  passingScore: 0.6, // 3/5 or above passes
})
```

**Combine with deterministic scorers.** `Scorer.llm` is semantically rich but costs tokens. Use cheap structural checks first:

```typescript
scorers: [
  Scorer.contains(['total', 'invoice_no']),                              // free
  Scorer.fieldAccuracy(['total'], { tolerance: 0.01 }),                  // free
  Scorer.llm(judge, { criteria: 'Is the extraction faithful?' }),        // costs tokens
]
```

See [`examples/05-judge-agent.ts`](examples/05-judge-agent.ts) for a full summarisation eval.

## Comparing models

`EvalRunner.compare` runs the same dataset and scorers against multiple targets and returns one report per target — each with its own per-case token counts in `report.tokenCost`, so you can find the cheapest model that meets your quality bar, or catch quality regressions when upgrading. It always returns every report (it deliberately takes no `failIf` — aborting mid-comparison would throw away the other targets' results); gate on thresholds per-target after it returns.

```typescript
import { ClaudeAgent, OpenAiAgent, MistralAgent } from '@agentionai/agents';

const reports = await EvalRunner.compare(dataset, [
  Scorer.fieldAccuracy(['invoice_no', 'total'], { tolerance: 0.01 }),
  Scorer.llm(judge, { criteria: 'Is the extraction faithful to the source?' }),
], {
  'claude-haiku':  new ClaudeAgent({ ..., model: 'claude-haiku-4-5-20251001', temperature: 0.3 }),
  'claude-sonnet': new ClaudeAgent({ ..., model: 'claude-sonnet-4-6',         temperature: 0.3 }),
  'gpt-4o-mini':   new OpenAiAgent({ ..., model: 'gpt-4o-mini',               temperature: 0.3 }),
  'mistral-small': new MistralAgent({ ..., model: 'mistral-small-latest',     temperature: 0.3 }),
});

for (const [model, report] of Object.entries(reports)) {
  console.log(`\n--- ${model} ---`);
  console.log(formatReport(report));
}
```

The judge must be shared across all targets and run at `temperature: 0`. A judge that varies between runs makes cross-model scores incomparable.

See [`examples/06-judge-comparison.ts`](examples/06-judge-comparison.ts) for the full working example.

## Comparing prompts

Keep the model fixed and vary the system prompt across targets. This is the fastest way to A/B test prompt variants before shipping.

```typescript
const make = (id: string, description: string) =>
  new ClaudeAgent({ id, name: id, description, apiKey, model, temperature: 0.3 });

const reports = await EvalRunner.compare(dataset, scorers, {
  'minimal':          make('minimal',          'Summarise the text.'),
  'explicit':         make('explicit',         'Summarise in 1–2 sentences. Do not add information.'),
  'framed':           make('framed',           'Write a one-sentence abstract. Capture only the facts.'),
  'chain-of-thought': make('chain-of-thought', 'Identify the 2–3 key facts, then summarise them faithfully.'),
});

// Ranked summary
Object.entries(reports)
  .sort(([, a], [, b]) => (b.scores['llm'] ?? 0) - (a.scores['llm'] ?? 0))
  .forEach(([name, r], i) =>
    console.log(`${i + 1}. ${name.padEnd(20)} score: ${r.scores['llm']?.toFixed(3)}`)
  );
```

See [`examples/07-compare-prompts.ts`](examples/07-compare-prompts.ts) for the full working example.

## PDF / document extraction

`Scorer.fieldAccuracy` handles the messy reality of LLM extraction output — currency symbols, number formatting, boolean strings — so you don't have to normalise before comparing.

```typescript
import { ClaudeAgent } from '@agentionai/agents';
import { z } from 'zod';

const extractor = new ClaudeAgent({
  id: 'extractor',
  name: 'Invoice Extractor',
  description: 'Extract invoice fields. Return JSON only: { invoice_no, date, vendor, total }.',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
  temperature: 0.1,
});

const dataset = new EvalDataset([
  {
    input: 'INVOICE\nFrom: Acme Corp\nInvoice #: INV-001\nDate: January 15, 2024\nTotal Due: $1,250.00',
    expected: { invoice_no: 'INV-001', date: '2024-01-15', vendor: 'Acme Corp', total: 1250 },
    metadata: { document_type: 'invoice' },
  },
]);

const runner = new EvalRunner({
  target: extractor,
  dataset,
  scorers: [
    Scorer.jsonSchema(z.object({
      invoice_no: z.string(),
      date: z.string(),
      vendor: z.string(),
      total: z.number(),
    })),
    Scorer.fieldAccuracy(['invoice_no', 'vendor', 'total'], { tolerance: 0.01 }),
  ],
  concurrency: 2,
  failIf: { scores: { fieldAccuracy: { lt: 0.95 } } },
});
```

See [`examples/02-invoice-extraction.ts`](examples/02-invoice-extraction.ts) for the full example.

## CI thresholds

`failIf` causes `runner.run()` to throw `EvalThresholdError` when quality drops below a threshold, which exits the process non-zero in CI. The full report is still attached to the error.

```typescript
import { EvalThresholdError } from '@agentionai/eval';

try {
  const report = await runner.run();
  console.log(formatReport(report));
} catch (err) {
  if (err instanceof EvalThresholdError) {
    console.log(formatReport(err.report));   // full report on the error
    console.error(err.violations);           // ['passRate 66.7% < 80.0%', ...]
    process.exit(1);
  }
}
```

```typescript
failIf: {
  passRate: { lt: 0.8 },                    // fewer than 80% of cases pass
  scores: {
    fieldAccuracy: { lt: 0.95 },            // field accuracy mean below 95%
    llm:           { lt: 0.6  },            // judge mean below 60%
  },
}
```

Supported operators: `lt` (less than), `lte` (less than or equal).

## Scorers

### `Scorer.llm(judgeAgent, options)`

Semantic scoring via a judge agent. Use for open-ended outputs where correctness can't be captured by a rule.

The judge receives `input`, `output`, `expected`, and `criteria` in its prompt and must return `{ score: number, reason: string }` JSON. The `reason` is surfaced in `ScorerResult.reason` and printed in all report formats.

```typescript
Scorer.llm(judge, {
  criteria: 'Does the summary faithfully cover the key points in the Expected field?',
  scale: 5,          // score range 1–N, normalised to 0–1 (default: 5)
  passingScore: 0.6, // normalised threshold to pass (default: 0.6)
})
```

### `Scorer.fieldAccuracy(fields, options?)`

Fuzzy field matching for structured extraction output. The `tolerance` option sets the maximum relative error for numeric fields (e.g. `0.01` = 1%). Normalises values before comparing:

| Input string | Normalised to |
|---|---|
| `"$1,250.00"` / `"£890.50"` / `"€2.400,00"` | `1250` / `890.5` / `2400` |
| `"Yes"` / `"true"` / `"1"` | `true` |
| `"No"` / `"false"` / `"0"` | `false` |
| `"25%"` | `25` |

```typescript
Scorer.fieldAccuracy(['invoice_no', 'total', 'vendor'], { tolerance: 0.01 })
```

### `Scorer.jsonSchema(schema)`

Passes if the output (parsed as JSON) validates against a Zod schema or a plain JSON Schema object.

```typescript
// Zod
Scorer.jsonSchema(z.object({ total: z.number(), vendor: z.string() }))

// Plain JSON Schema
Scorer.jsonSchema({ type: 'object', required: ['total'], properties: { total: { type: 'number' } } })
```

### `Scorer.exactMatch(fields?)`

Parses output as JSON and compares fields against `expected` with value normalisation. If `fields` is omitted, all keys from `expected` are checked.

```typescript
Scorer.exactMatch()                        // check all fields
Scorer.exactMatch(['invoice_no', 'total']) // check specific fields
```

### `Scorer.contains(keywords, options?)`

Passes if all keywords appear in the output. Case-insensitive by default.

```typescript
Scorer.contains(['invoice', 'total'])
Scorer.contains(['INV-001'], { caseSensitive: true })
```

### `Scorer.custom(name, fn)`

Escape hatch for any logic not covered above.

```typescript
Scorer.custom('wordCount', async (output, expected) => {
  const count = output.split(' ').length;
  const pass = count <= (expected as number);
  return { pass, score: pass ? 1 : 0, scorerName: 'wordCount' };
})
```

## Dataset

```typescript
// From an array
const dataset = new EvalDataset([
  { input: 'text', expected: { field: 'value' }, metadata: { source: 'doc-1' } },
]);

// From a JSONL file (each line is an EvalCase object)
const dataset = await EvalDataset.fromJsonl<string>('./cases.jsonl');

// From raw data with a mapper
const dataset = EvalDataset.fromArray(rawRows, (row) => ({
  input: row.text,
  expected: { total: row.amount },
  metadata: { document_type: row.type },
}));
```

## EvalRunner options

```typescript
new EvalRunner({
  target,       // EvalTarget — any object with execute()
  dataset,      // EvalDataset
  scorers,      // IScorer[] — applied to every case
  concurrency,  // parallel case execution (default: 1)
  metrics,      // MetricsCollector from createMetricsCollector()
  failIf,       // EvalFailConditions — throw EvalThresholdError if not met
  onCaseComplete(result, index) {
    const llm = result.scores.find(s => s.scorerName === 'llm');
    console.log(result.pass ? 'PASS' : 'FAIL', llm?.reason);
  },
})
```

Per-case token counts are captured automatically for agent targets — every Agention agent (`ClaudeAgent`, `OpenAiAgent`, `MistralAgent`, …) reports its usage after each `execute()`, and the runner reads it with no setup. The optional `metrics` collector is only needed for composite **graph / pipeline** targets, which report token usage through a `MetricsCollector` rather than on the target instance: create one with `createMetricsCollector()`, wire it to the pipeline with `.withMetrics(metrics)`, and the runner reads `getAggregateMetrics()` snapshots as a fallback. Either way, per-case counts are accurate at `concurrency: 1` and approximate otherwise — a shared target's usage is overwritten by overlapping cases.

## Output formats

### Human-readable

```typescript
import { formatReport } from '@agentionai/eval';

console.log(formatReport(report));
// Group results by a metadata key to spot per-segment regressions
console.log(formatReport(report, { groupBy: 'document_type' }));
```

```
=== Eval Report ===
Passed:   8 / 10 (80.0%)
Failed:   2
Duration: 3,241ms
Tokens:   12,450 total (1245.0 / case)

Scorer Results:
  jsonSchema           [████████████████████]  1.000
  fieldAccuracy        [████████████████░░░░]  0.800
  llm                  [███████████████░░░░░]  0.740

Results by document_type:
  invoice                  5/6 (83.3%)
  receipt                  3/4 (75.0%)

Failed Cases (2):
  input: "INVOICE\nFrom: Acme Corp..."
  metadata: {"document_type":"invoice","source":"batch-3"}
    [FAIL] fieldAccuracy: total: expected 1250, got 1150
    [FAIL] llm: The summary omits the vendor name entirely.
```

### TAP 14

```typescript
import { formatReportTap } from '@agentionai/eval';
process.stdout.write(formatReportTap(report));
```

Pipeable to any TAP consumer:

```bash
node --import tsx eval.ts | npx tap-spec     # pretty terminal output
node --import tsx eval.ts | npx tap-junit > results.xml   # JUnit XML for CI
node --import tsx eval.ts | npx tap-dot       # dot reporter
```

## Types

```typescript
interface EvalCase<TInput = string> {
  input: TInput;
  expected?: unknown;
  metadata?: Record<string, unknown>;
}

interface EvalCaseResult<TInput = string> {
  case: EvalCase<TInput>;
  output: string;
  scores: ScorerResult[];
  pass: boolean;           // true if every scorer passed
  durationMs: number;
  tokens?: { input: number; output: number; total: number };
}

interface EvalReport<TInput = string> {
  passed: number;
  failed: number;
  total: number;
  passRate: number;
  scores: Record<string, number>;  // scorer name → mean score across all cases
  tokenCost: { total: number; perCase: number };
  durationMs: number;
  cases: EvalCaseResult<TInput>[];
}

// Structural — satisfied by any Agention Pipeline, AgentGraph, or GraphNode
interface EvalTarget<TInput = string> {
  execute(input: TInput): Promise<string | { toString(): string }>;
}
```
