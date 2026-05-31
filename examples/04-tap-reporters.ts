/**
 * TAP output example — three ways to consume eval results.
 *
 * TAP (Test Anything Protocol) is a line-based format understood by many
 * CI systems and reporter tools. `formatReportTap` produces a valid TAP 14
 * string from any EvalReport.
 *
 * Piping patterns (run these in your shell):
 *
 *   Raw TAP to stdout:
 *     node --import tsx examples/04-tap-reporters.ts
 *
 *   Pretty spec output via tap-spec:
 *     node --import tsx examples/04-tap-reporters.ts | npx tap-spec
 *
 *   JUnit XML for CI (e.g. GitHub Actions test summary):
 *     node --import tsx examples/04-tap-reporters.ts | npx tap-junit > results.xml
 *
 *   Dot reporter via tap-dot:
 *     node --import tsx examples/04-tap-reporters.ts | npx tap-dot
 */
import { writeFileSync } from 'node:fs';
import { EvalDataset, EvalRunner, EvalReport, Scorer, formatReportTap } from '../src';

// --- shared dataset & runner -------------------------------------------

const pipeline = {
  async execute(input: string): Promise<string> {
    return JSON.stringify({ value: input.trim().toUpperCase(), length: input.trim().length });
  },
};

const dataset = new EvalDataset([
  { name: 'uppercases a single word',          input: 'hello',       expected: { value: 'HELLO',  length: 5 } },
  { name: 'reports the correct length',        input: 'world',       expected: { value: 'WORLD',  length: 5 } },
  { name: 'trims surrounding whitespace',      input: '  foo bar  ', expected: { value: 'FOO BAR', length: 7 } },
  { name: 'handles a three-letter word',       input: 'baz',         expected: { value: 'BAZ',    length: 3 } },
]);

const scorers = [
  Scorer.jsonSchema({ type: 'object', required: ['value', 'length'] }),
  Scorer.fieldAccuracy(['value', 'length']),
];

new EvalRunner({ target: pipeline, dataset, scorers }).run().then((report) => {
  const REPORTER = process.env.REPORTER ?? 'tap';

  // --- Reporter 1: raw TAP to stdout (pipe to any TAP consumer) ----------
  if (REPORTER === 'tap') {
    process.stdout.write(formatReportTap(report));
  }

  // --- Reporter 2: inline spec-style -------------------------------------
  if (REPORTER === 'spec') {
    specReporter(report);
  }

  // --- Reporter 3: write TAP to file (CI artifact) -----------------------
  if (REPORTER === 'file') {
    const path = 'eval-results.tap';
    writeFileSync(path, formatReportTap(report), 'utf-8');
    console.log(`TAP written to ${path}`);
    console.log(`Pass rate: ${(report.passRate * 100).toFixed(1)}%`);
  }
}).catch(console.error);

// -----------------------------------------------------------------------

function specReporter(r: EvalReport) {
  const tick  = '\x1b[32m✓\x1b[0m';
  const cross = '\x1b[31m✗\x1b[0m';

  console.log();
  for (const [i, c] of r.cases.entries()) {
    const icon    = c.pass ? tick : cross;
    const preview = c.case.name ?? JSON.stringify(c.case.input).slice(0, 50);
    console.log(`  ${icon}  ${i + 1}) ${preview}`);
    if (!c.pass) {
      for (const s of c.scores.filter((s) => !s.pass)) {
        console.log(`       \x1b[31m${s.scorerName}: ${s.reason ?? 'failed'}\x1b[0m`);
      }
    }
  }

  const color = r.failed === 0 ? '\x1b[32m' : '\x1b[31m';
  console.log();
  console.log(`  ${color}${r.passed} passing\x1b[0m  ${r.failed > 0 ? `\x1b[31m${r.failed} failing\x1b[0m` : ''}  (${r.durationMs}ms)`);
  console.log();
}
