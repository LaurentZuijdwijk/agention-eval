/**
 * Basic example — no API key required.
 * Shows the core eval loop using a plain function as the target.
 *
 * Demonstrates:
 *  - Scorer.contains: passes only when all keywords appear in the output
 *  - Scorer.custom: arbitrary scoring logic
 *  - onCaseComplete: streaming per-case results
 */
import assert from 'node:assert';
import { EvalDataset, EvalRunner, Scorer, formatReport } from '../src';

// Any object with execute() satisfies EvalTarget — no agent needed
const upperCasePipeline = {
  async execute(input: string): Promise<string> {
    return input.toUpperCase();
  },
};

const dataset = new EvalDataset([
  { input: 'hello world', expected: 'HELLO WORLD' },
  { input: 'foo bar',     expected: 'FOO BAR' },
  { input: 'baz',         expected: 'BAZ' },
]);

const runner = new EvalRunner({
  target: upperCasePipeline,
  dataset,
  scorers: [
    // Passes only for the first case (only output that contains 'HELLO')
    Scorer.contains(['HELLO'], { caseSensitive: true }),

    // Custom scorer: passes for all three cases
    Scorer.custom('exactString', async (output, expected) => {
      const pass = output.trim() === String(expected);
      return { pass, score: pass ? 1 : 0, scorerName: 'exactString' };
    }),
  ],
  onCaseComplete(result, index) {
    const status = result.pass ? 'PASS' : 'FAIL';
    console.log(`  [${index + 1}] ${status} — "${result.output}"`);
  },
});

runner.run().then((report) => {
  console.log(formatReport(report));
  // exactString matched all 3; contains only matched 1
  assert.strictEqual(report.scores['exactString'], 1);
  assert.strictEqual(report.passed, 1);
  console.log('Assertions passed.');
}).catch(console.error);
