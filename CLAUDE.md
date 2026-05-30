# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@agentionai/eval` — a TypeScript eval framework for AI agent pipelines. Peer-depends on `@agentionai/agents`. Primary use case: evaluating PDF data extraction pipelines across models and prompts.

## Commands

```bash
npm install          # install deps
npm run build        # tsc compile to dist/
npm run test                                           # run all tests
node --import tsx --test src/scorer.test.ts            # run a single test file
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
```

## Package Structure

```
packages/eval/
├── src/
│   ├── index.ts       # public exports
│   ├── types.ts       # shared interfaces (EvalCase, ScorerResult, EvalCaseResult, EvalReport, IScorer, EvalTarget)
│   ├── dataset.ts     # EvalDataset — wraps EvalCase[], supports fromJsonl/fromArray
│   ├── scorer.ts      # Scorer factory — contains/exactMatch/jsonSchema/llm/fieldAccuracy/custom
│   ├── runner.ts      # EvalRunner + EvalRunner.compare()
│   └── report.ts      # EvalReport type + formatReport() helper
```

## Architecture

### Data flow

`EvalDataset` → `EvalRunner` → per-case `EvalTarget.execute()` → `IScorer[]` → `EvalReport`

`EvalRunner` runs cases with a configurable concurrency limit (semaphore pattern, no external dep). Each case result captures output, per-scorer `ScorerResult`, pass/fail, duration, and optional token counts.

### Key design rules

- **Zero magic** — no decorators, no config files. Everything is typed objects and function calls.
- **`EvalTarget`** is a structural interface (`{ execute(input): Promise<string | { toString() }> }`), so any Agention `Pipeline`, `AgentGraph`, or `GraphNode` satisfies it without wrapping.
- **`Scorer.llm()`** reuses the `AgentGraph.votingSystem(judge)` judge pattern — the judge agent receives `{ input, output, expected, criteria }` and must return `{ score: number, reason: string }` JSON.
- **`Scorer.fieldAccuracy()`** is the most important scorer for PDF extraction. Value normalization must handle: currency symbols (`$1,250.00` → `1250`), boolean strings (`"Yes"` → `true`), number formatting, and configurable numeric tolerance.
- **Metrics integration**: if `metrics` (a `createMetricsCollector()` result) is passed to `EvalRunner`, token data is read from `metrics.getAggregateMetrics()` after each case and attached to `EvalCaseResult`.
- **Error isolation**: a case that throws must produce `pass: false` with the error in `reason` — it must not crash the run.

### Agention primitives to integrate with

From `@agentionai/agents`:
- `createMetricsCollector()` — returns a metrics object; call `.withMetrics(metrics)` on a pipeline, then `.getAggregateMetrics()` to read totals.
- `AgentGraph.votingSystem(judge)` — judge receives `{ originalInput, solutions[] }` and returns the winning solution. `Scorer.llm()` adapts this pattern.
- `Pipeline` / `AgentGraph.pipeline(...nodes)` — sequential composition; `.execute(input)` returns a string.

### `EvalRunner.compare()`

Static method that runs the same `EvalDataset` + `IScorer[]` against a map of named `EvalTarget`s and returns `Record<name, EvalReport>` for side-by-side model/prompt comparison.
