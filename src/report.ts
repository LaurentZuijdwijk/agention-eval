import { EvalReport } from './types';

export interface FormatReportOptions {
  groupBy?: string;  // a metadata key — shows per-group pass rates before the failed cases
}

export function formatReport<TInput = string>(
  report: EvalReport<TInput>,
  options: FormatReportOptions = {}
): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  lines.push('');
  lines.push('=== Eval Report ===');
  lines.push(`Passed:   ${report.passed} / ${report.total} (${pct(report.passRate)})`);
  lines.push(`Failed:   ${report.failed}`);
  lines.push(`Duration: ${report.durationMs.toLocaleString()}ms`);

  if (report.tokenCost.total > 0) {
    lines.push(
      `Tokens:   ${report.tokenCost.total.toLocaleString()} total` +
      ` (${report.tokenCost.perCase.toFixed(1)} / case)`
    );
  }

  if (Object.keys(report.scores).length > 0) {
    lines.push('');
    lines.push('Scorer Results:');
    for (const [name, meanScore] of Object.entries(report.scores)) {
      const bar = buildBar(meanScore, 20);
      lines.push(`  ${pad(name, 20)} ${bar}  ${meanScore.toFixed(3)}`);
    }
  }

  if (options.groupBy) {
    const key = options.groupBy;
    const groups = new Map<string, { passed: number; total: number }>();
    for (const c of report.cases) {
      const groupVal = String(c.case.metadata?.[key] ?? '(none)');
      const entry = groups.get(groupVal) ?? { passed: 0, total: 0 };
      entry.total += 1;
      if (c.pass) entry.passed += 1;
      groups.set(groupVal, entry);
    }
    lines.push('');
    lines.push(`Results by ${key}:`);
    for (const [groupVal, { passed, total }] of groups) {
      const rate = pct(passed / total);
      lines.push(`  ${pad(groupVal, 24)} ${passed}/${total} (${rate})`);
    }
  }

  const failedCases = report.cases.filter((c) => !c.pass);
  if (failedCases.length > 0) {
    lines.push('');
    lines.push(`Failed Cases (${failedCases.length}):`);
    for (const c of failedCases) {
      const inputPreview = JSON.stringify(c.case.input).slice(0, 80);
      if (c.case.name) lines.push(`  ✗ ${c.case.name}`);
      lines.push(`  input: ${inputPreview}`);
      if (c.case.metadata && Object.keys(c.case.metadata).length > 0) {
        lines.push(`  metadata: ${JSON.stringify(c.case.metadata)}`);
      }
      if (c.toolCalls && c.toolCalls.length > 0) {
        lines.push(`  tools: ${c.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.input)})`).join(' → ')}`);
      }
      for (const s of c.scores.filter((s) => !s.pass)) {
        lines.push(`    [FAIL] ${s.scorerName}: ${s.reason ?? 'no reason'}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

function buildBar(score: number, width: number): string {
  const filled = Math.round(score * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

export function formatReportTap<TInput = string>(report: EvalReport<TInput>): string {
  const lines: string[] = [];

  lines.push('TAP version 14');
  lines.push(`1..${report.total}`);

  report.cases.forEach((c, i) => {
    const n = i + 1;
    const inputPreview = JSON.stringify(c.case.input).slice(0, 60);
    const description = c.case.name ?? inputPreview;
    const firstFail = c.scores.find((s) => !s.pass);
    const hasMeta = c.case.metadata && Object.keys(c.case.metadata).length > 0;

    if (c.pass) {
      lines.push(`ok ${n} - ${description}`);
      if (hasMeta) {
        lines.push('  ---');
        lines.push(`  metadata: ${JSON.stringify(c.case.metadata)}`);
        lines.push('  ...');
      }
    } else {
      lines.push(`not ok ${n} - ${description}${firstFail ? ` # ${firstFail.scorerName}` : ''}`);
      lines.push('  ---');
      // Include the input as a diagnostic — when `name` is the description, the
      // input is no longer on the test line, so surface it here for debugging.
      lines.push(`  input: ${inputPreview}`);
      lines.push(`  duration_ms: ${c.durationMs}`);
      if (c.tokens) {
        lines.push(`  tokens: ${c.tokens.total}`);
      }
      if (hasMeta) {
        lines.push(`  metadata: ${JSON.stringify(c.case.metadata)}`);
      }
      lines.push('  scores:');
      for (const s of c.scores) {
        const suffix = s.pass ? '' : ` # ${s.reason ?? 'failed'}`;
        lines.push(`    ${s.scorerName}: ${s.score.toFixed(3)}${suffix}`);
      }
      lines.push('  ...');
    }
  });

  lines.push(`# tests ${report.total}`);
  lines.push(`# pass ${report.passed}`);
  lines.push(`# fail ${report.failed}`);
  lines.push(`# duration_ms ${report.durationMs}`);

  return lines.join('\n') + '\n';
}
