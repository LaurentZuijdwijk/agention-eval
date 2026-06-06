/**
 * Refinement loop example — no API key required.
 *
 * Shows EvalRunner.refine(): for each case, generate beamWidth candidates per
 * round, keep the best-scoring one, then feed it back as context for the next
 * round via buildInput. Pass rate improves because the target can "build on"
 * its prior best attempt rather than starting from scratch every time.
 *
 * Mock target behaviour (deterministic, no external calls):
 *   Round 0 (no PREV context): cycles through 3 quality levels (2/4, 3/4, 3/4
 *     fields). Best-of-3 is always 3/4 → score 0.75 → never passes.
 *   Round 1 (PREV: prefix injected by buildInput): returns all 4 fields →
 *     score 1.0 → all cases pass.
 *
 * Expected assertions:
 *   callCount === beamWidth(3) × rounds(2) × cases(3) = 18
 *   rounds[0].passRate === 0   (best-of-3 still misses a field)
 *   rounds[1].passRate === 1   (guided by previous best)
 *   improvement === 1.0
 */
import assert from 'node:assert';
import { EvalDataset, EvalRunner, Scorer, formatReport } from '../src';

// --- Mock target ---

function parseInvoice(text: string): Record<string, unknown> {
  return {
    invoice_no: text.match(/INV-\d+/)?.[0] ?? '',
    vendor: text.match(/From:\s*([^\n]+)/)?.[1]?.trim() ?? '',
    total: parseFloat(
      (text.match(/(?:Total|Amount):\s*\$?([\d,]+\.?\d*)/)?.[1] ?? '0').replace(/,/g, ''),
    ),
    date: text.match(/(\d{4}-\d{2}-\d{2})/)?.[0] ?? '',
  };
}

let callSeq = 0;

const flakyExtractor = {
  async execute(input: string): Promise<string> {
    const correct = parseInvoice(input);

    // With PREV context the target always returns the complete answer.
    if (input.includes('PREV:')) {
      callSeq++;
      return JSON.stringify(correct);
    }

    // Without context: cycle through 3 quality levels so no single candidate
    // ever returns all 4 fields. Best-of-3 scores 0.75 but never passes.
    const quality = callSeq++ % 3;
    const entries = Object.entries(correct);
    // quality 0 → 2 fields, quality 1 or 2 → 3 fields (different missing field)
    const kept = quality === 0 ? entries.slice(0, 2) : quality === 1 ? entries.slice(0, 3) : entries.slice(1);
    return JSON.stringify(Object.fromEntries(kept));
  },
};

// --- Dataset ---

const dataset = new EvalDataset([
  {
    name: 'USD invoice',
    input: 'From: Acme Corp\nInvoice #: INV-001\nDate: 2024-01-15\nTotal: $1,250.00',
    expected: { invoice_no: 'INV-001', vendor: 'Acme Corp', total: 1250, date: '2024-01-15' },
  },
  {
    name: 'GBP invoice',
    input: 'From: Globex Ltd\nInvoice #: INV-002\nDate: 2024-02-01\nAmount: $890.50',
    expected: { invoice_no: 'INV-002', vendor: 'Globex Ltd', total: 890.5, date: '2024-02-01' },
  },
  {
    name: 'Initech invoice',
    input: 'From: Initech\nInvoice #: INV-003\nDate: 2024-03-03\nTotal: $2,400.00',
    expected: { invoice_no: 'INV-003', vendor: 'Initech', total: 2400, date: '2024-03-03' },
  },
]);

const FIELDS = ['invoice_no', 'vendor', 'total', 'date'];

// --- Run ---

EvalRunner.refine({
  dataset,
  target: flakyExtractor,
  scorers: [Scorer.fieldAccuracy(FIELDS, { tolerance: 0.01 })],
  rounds: 2,
  beamWidth: 3,
  // Append the best candidate from the previous round as context.
  // A real LLM target would use this to fill in missing fields.
  buildInput: (original, [best]) =>
    `${original}\n\nPREV: ${best}\nFill in any missing fields from the previous attempt.`,
  onRoundComplete(round, report) {
    console.log(
      `Round ${round + 1}: ${report.passed}/${report.total} passed` +
        ` (fieldAccuracy mean: ${(report.scores['fieldAccuracy'] * 100).toFixed(0)}%)`,
    );
  },
})
  .then((refineReport) => {
    console.log('\nPer-round pass rates:');
    refineReport.rounds.forEach((r, i) =>
      console.log(`  Round ${i + 1}: ${(r.passRate * 100).toFixed(0)}%`),
    );
    console.log(`Improvement: +${(refineReport.improvement * 100).toFixed(0)}pp\n`);
    console.log(formatReport(refineReport.final));

    assert.strictEqual(callSeq, 18, `Expected 18 target calls (2 rounds × 3 beamWidth × 3 cases), got ${callSeq}`);
    assert.strictEqual(refineReport.rounds[0].passRate, 0, 'Round 0: no passes (missing field every time)');
    assert.strictEqual(refineReport.rounds[1].passRate, 1, 'Round 1: all pass (guided by PREV context)');
    assert.ok(refineReport.improvement > 0, 'improvement should be positive');
    console.log('Assertions passed.');
  })
  .catch(console.error);
