/**
 * Native node:test integration — run evals with Node's built-in test runner.
 *
 * Rather than reinventing describe/it, @agentionai/eval composes *into* the test
 * runner you already use. Run the eval once, then surface each case as a native
 * subtest: you get familiar BDD output, `--test-reporter` formats, watch mode,
 * and CI integration for free, with the eval scorers doing the judging.
 *
 * Run:
 *   node --import tsx --test examples/09-node-test.ts
 *   node --import tsx --test --test-reporter=spec examples/09-node-test.ts
 *   node --import tsx --test --watch examples/09-node-test.ts
 *
 * No API key required — the target is a plain function.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EvalDataset, EvalRunner, Scorer } from '../src';
import type { EvalCaseResult } from '../src';

// Any object with execute() is a valid target — swap for a real Agention agent.
const target = {
  async execute(input: string): Promise<string> {
    return JSON.stringify({ value: input.trim().toUpperCase(), length: input.trim().length });
  },
};

const dataset = new EvalDataset([
  { name: 'uppercases a single word',     input: 'hello',       expected: { value: 'HELLO',   length: 5 } },
  { name: 'trims surrounding whitespace', input: '  foo bar  ', expected: { value: 'FOO BAR', length: 7 } },
  { name: 'computes the correct length',  input: 'baz',         expected: { value: 'BAZ',     length: 3 } },
]);

const scorers = [
  Scorer.jsonSchema({ type: 'object', required: ['value', 'length'] }),
  Scorer.fieldAccuracy(['value', 'length']),
];

// Run the whole dataset ONCE — a single pass that respects concurrency and
// captures tokens/tool calls. Every test below awaits this shared promise, so
// the eval never runs more than once no matter how many subtests read it.
const reportPromise = new EvalRunner({ target, dataset, scorers }).run();

const failureMessage = (c: EvalCaseResult) =>
  c.scores
    .filter((s) => !s.pass)
    .map((s) => `${s.scorerName}: ${s.reason ?? 'failed'}`)
    .join('\n');

// One subtest per case — the case `name` becomes the test description, so the
// runner prints exactly what each case verifies.
describe('uppercase extractor', () => {
  dataset.cases.forEach((evalCase, i) => {
    it(evalCase.name ?? JSON.stringify(evalCase.input), async () => {
      const report = await reportPromise;
      const result = report.cases[i];
      assert.ok(result.pass, failureMessage(result));
    });
  });
});

// Suite-level quality gates — assert on the aggregate report. This is the
// node:test equivalent of `failIf`, useful when you'd rather gate in your test
// suite than catch EvalThresholdError.
describe('quality gates', () => {
  it('passes at least 90% of cases', async () => {
    const { passRate } = await reportPromise;
    assert.ok(passRate >= 0.9, `pass rate ${(passRate * 100).toFixed(1)}% < 90%`);
  });

  it('keeps field accuracy above 0.95', async () => {
    const { scores } = await reportPromise;
    assert.ok((scores.fieldAccuracy ?? 0) >= 0.95, `fieldAccuracy ${scores.fieldAccuracy?.toFixed(3)} < 0.95`);
  });
});
