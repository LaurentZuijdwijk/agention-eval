import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, formatReportTap } from './report';
import type { EvalReport } from './types';

// ---- Helpers ----

function makeReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    passed: 2,
    failed: 1,
    total: 3,
    passRate: 2 / 3,
    scores: { fieldAccuracy: 0.75 },
    tokenCost: { total: 0, perCase: 0 },
    durationMs: 123,
    cases: [
      {
        case: { input: 'hello', name: 'greeting case' },
        output: 'hi',
        scores: [{ pass: true, score: 1, scorerName: 'fieldAccuracy' }],
        pass: true,
        durationMs: 10,
      },
      {
        case: { input: 'world' },
        output: 'nope',
        scores: [{ pass: false, score: 0, scorerName: 'fieldAccuracy', reason: 'value mismatch' }],
        pass: false,
        durationMs: 20,
      },
      {
        case: { input: 'foo', metadata: { category: 'A' } },
        output: 'bar',
        scores: [{ pass: true, score: 1, scorerName: 'fieldAccuracy' }],
        pass: true,
        durationMs: 30,
      },
    ],
    ...overrides,
  };
}

// ---- formatReport ----

describe('formatReport', () => {
  it('contains the report header', () => {
    const out = formatReport(makeReport());
    assert.ok(out.includes('=== Eval Report ==='));
  });

  it('shows pass/fail/total counts', () => {
    const out = formatReport(makeReport());
    assert.ok(out.includes('2 / 3'));
    assert.ok(out.includes('Failed:   1'));
  });

  it('shows pass rate as percentage', () => {
    const out = formatReport(makeReport());
    assert.ok(out.includes('66.7%'));
  });

  it('shows duration in ms', () => {
    const out = formatReport(makeReport());
    assert.ok(out.includes('123'));
  });

  it('shows scorer results section with mean score', () => {
    const out = formatReport(makeReport());
    assert.ok(out.includes('Scorer Results'));
    assert.ok(out.includes('fieldAccuracy'));
    assert.ok(out.includes('0.750'));
  });

  it('omits token line when total tokens = 0', () => {
    const out = formatReport(makeReport({ tokenCost: { total: 0, perCase: 0 } }));
    assert.ok(!out.includes('Tokens:'));
  });

  it('shows token line when tokens > 0', () => {
    const out = formatReport(makeReport({ tokenCost: { total: 500, perCase: 166.7 } }));
    assert.ok(out.includes('Tokens:'));
    assert.ok(out.includes('500'));
  });

  it('shows failed cases section with scorer reason', () => {
    const out = formatReport(makeReport());
    assert.ok(out.includes('Failed Cases'));
    assert.ok(out.includes('value mismatch'));
    assert.ok(out.includes('fieldAccuracy'));
  });

  it('shows case name in failed cases when present', () => {
    const report = makeReport();
    // Make the named case fail
    report.cases[0].pass = false;
    report.passed = 1;
    report.failed = 2;
    const out = formatReport(report);
    assert.ok(out.includes('greeting case'));
  });

  it('does not show failed cases section when all pass', () => {
    const report = makeReport({ passed: 3, failed: 0, passRate: 1 });
    report.cases.forEach((c) => { c.pass = true; });
    const out = formatReport(report);
    assert.ok(!out.includes('Failed Cases'));
  });

  it('groups results by metadata key with groupBy option', () => {
    const out = formatReport(makeReport(), { groupBy: 'category' });
    assert.ok(out.includes('Results by category'));
    assert.ok(out.includes('A'));
    assert.ok(out.includes('(none)'));
  });
});

// ---- formatReportTap ----

describe('formatReportTap', () => {
  it('starts with TAP version header', () => {
    const out = formatReportTap(makeReport());
    assert.ok(out.startsWith('TAP version 14\n'));
  });

  it('has a plan line 1..N', () => {
    const out = formatReportTap(makeReport());
    assert.ok(out.includes('1..3'));
  });

  it('emits "ok N" for passing cases', () => {
    const out = formatReportTap(makeReport());
    assert.ok(out.includes('ok 1 -'));
    assert.ok(out.includes('ok 3 -'));
  });

  it('uses case name as description when present', () => {
    const out = formatReportTap(makeReport());
    assert.ok(out.includes('greeting case'));
  });

  it('falls back to input preview when name is absent', () => {
    const out = formatReportTap(makeReport());
    // Case 2 has no name; input is "world"
    assert.ok(out.includes('"world"'));
  });

  it('emits "not ok N" for failing cases', () => {
    const out = formatReportTap(makeReport());
    assert.ok(out.includes('not ok 2 -'));
  });

  it('includes scorer name in failing line', () => {
    const out = formatReportTap(makeReport());
    assert.ok(out.includes('# fieldAccuracy'));
  });

  it('includes diagnostic block for failing cases', () => {
    const out = formatReportTap(makeReport());
    assert.ok(out.includes('  ---'));
    assert.ok(out.includes('  ...'));
    assert.ok(out.includes('value mismatch'));
  });

  it('includes summary counts at the end', () => {
    const out = formatReportTap(makeReport());
    assert.ok(out.includes('# tests 3'));
    assert.ok(out.includes('# pass 2'));
    assert.ok(out.includes('# fail 1'));
  });

  it('includes duration in summary', () => {
    const out = formatReportTap(makeReport());
    assert.ok(out.includes('# duration_ms'));
  });

  it('includes token count in diagnostic when tokens are present', () => {
    const report = makeReport();
    report.cases[1].tokens = { input: 10, output: 20, total: 30 };
    const out = formatReportTap(report);
    assert.ok(out.includes('tokens: 30'));
  });
});
