import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EvalDataset } from './dataset';
import { EvalRunner, EvalThresholdError } from './runner';
import { Scorer } from './scorer';
import type { EvalTarget, IScorer, ScorerResult } from './types';

// ---- Helpers ----

const makeTarget = (response: string | ((input: string) => string)): EvalTarget<string> => ({
  execute: async (input) =>
    typeof response === 'function' ? response(input) : response,
});

const failingTarget = (msg: string): EvalTarget<string> => ({
  execute: async () => { throw new Error(msg); },
});

const alwaysPass: IScorer<string> = {
  name: 'pass',
  score: async (): Promise<ScorerResult> => ({ pass: true, score: 1, scorerName: 'pass' }),
};

const alwaysFail: IScorer<string> = {
  name: 'fail',
  score: async (): Promise<ScorerResult> => ({ pass: false, score: 0, scorerName: 'fail', reason: 'always fails' }),
};

const ds = (inputs: string[]) =>
  new EvalDataset(inputs.map((input) => ({ input })));

// ---- EvalRunner.run() ----

describe('EvalRunner.run()', () => {
  it('returns a report with the correct shape', async () => {
    const runner = new EvalRunner({ target: makeTarget('hi'), dataset: ds(['a']), scorers: [alwaysPass] });
    const report = await runner.run();
    assert.equal(report.total, 1);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.passRate, 1);
    assert.ok(report.durationMs >= 0);
    assert.ok('pass' in report.scores);
    assert.equal(report.tokenCost.total, 0);
    assert.equal(report.cases.length, 1);
  });

  it('marks case as pass when all scorers pass', async () => {
    const runner = new EvalRunner({ target: makeTarget('hi'), dataset: ds(['a']), scorers: [alwaysPass] });
    const { cases } = await runner.run();
    assert.equal(cases[0].pass, true);
    assert.equal(cases[0].output, 'hi');
  });

  it('marks case as fail when any scorer fails', async () => {
    const runner = new EvalRunner({
      target: makeTarget('hi'),
      dataset: ds(['a']),
      scorers: [alwaysPass, alwaysFail],
    });
    const { cases } = await runner.run();
    assert.equal(cases[0].pass, false);
  });

  it('aggregates pass rate correctly across multiple cases', async () => {
    const target = makeTarget((input) => input === 'pass' ? 'yes' : 'no');
    const scorer = Scorer.contains(['yes']);
    const runner = new EvalRunner({
      target,
      dataset: new EvalDataset([{ input: 'pass' }, { input: 'fail' }, { input: 'pass' }]),
      scorers: [scorer],
    });
    const report = await runner.run();
    assert.equal(report.passed, 2);
    assert.equal(report.failed, 1);
    assert.ok(Math.abs(report.passRate - 2 / 3) < 1e-9);
  });

  it('isolates errors — a throwing target fails only that case, run continues', async () => {
    const dataset = new EvalDataset([{ input: 'ok' }, { input: 'boom' }, { input: 'ok' }]);
    const target: EvalTarget<string> = {
      execute: async (input) => {
        if (input === 'boom') throw new Error('kaboom');
        return 'good';
      },
    };
    const runner = new EvalRunner({ target, dataset, scorers: [alwaysPass] });
    const report = await runner.run();
    assert.equal(report.total, 3);
    assert.equal(report.failed, 1);
    assert.equal(report.cases[1].pass, false);
    assert.ok(report.cases[1].scores[0].reason?.includes('kaboom'));
    assert.equal(report.cases[0].pass, true);
    assert.equal(report.cases[2].pass, true);
  });

  it('calls onCaseComplete for each case', async () => {
    const completed: number[] = [];
    const runner = new EvalRunner({
      target: makeTarget('hi'),
      dataset: ds(['a', 'b', 'c']),
      scorers: [alwaysPass],
      onCaseComplete: (_, index) => completed.push(index),
    });
    await runner.run();
    assert.equal(completed.length, 3);
    assert.deepEqual(completed.sort(), [0, 1, 2]);
  });

  it('runs all cases with concurrency > 1', async () => {
    const runner = new EvalRunner({
      target: makeTarget('hi'),
      dataset: ds(['a', 'b', 'c', 'd']),
      scorers: [alwaysPass],
      concurrency: 4,
    });
    const report = await runner.run();
    assert.equal(report.total, 4);
    assert.equal(report.passed, 4);
  });

  it('preserves case order in results regardless of concurrency', async () => {
    const dataset = new EvalDataset([
      { input: 'first' },
      { input: 'second' },
      { input: 'third' },
    ]);
    const runner = new EvalRunner({
      target: makeTarget((i) => i),
      dataset,
      scorers: [alwaysPass],
      concurrency: 3,
    });
    const { cases } = await runner.run();
    assert.equal(cases[0].output, 'first');
    assert.equal(cases[1].output, 'second');
    assert.equal(cases[2].output, 'third');
  });

  it('computes mean score per scorer', async () => {
    const halfPass: IScorer<string> = {
      name: 'half',
      score: async (output): Promise<ScorerResult> => {
        const pass = output === 'good';
        return { pass, score: pass ? 1 : 0, scorerName: 'half' };
      },
    };
    const dataset = new EvalDataset([{ input: 'good' }, { input: 'bad' }]);
    const runner = new EvalRunner({ target: makeTarget((i) => i), dataset, scorers: [halfPass] });
    const report = await runner.run();
    assert.ok(Math.abs(report.scores['half'] - 0.5) < 1e-9);
  });

  it('captures toolCalls from a target that exposes getHistoryEntries()', async () => {
    const target = {
      execute: async (_: string) => 'done',
      getHistoryEntries: () => [
        { content: [{ type: 'tool_use', name: 'myTool', input: { x: 1 }, id: 'tc1' }] },
      ],
    };
    const runner = new EvalRunner({ target, dataset: ds(['input']), scorers: [alwaysPass] });
    const { cases } = await runner.run();
    assert.equal(cases[0].toolCalls?.length, 1);
    assert.equal(cases[0].toolCalls?.[0].name, 'myTool');
  });

  it('reads token usage from target.lastTokenUsage', async () => {
    const target = {
      execute: async (_: string) => 'done',
      lastTokenUsage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    };
    const runner = new EvalRunner({ target, dataset: ds(['x']), scorers: [alwaysPass] });
    const { cases } = await runner.run();
    assert.deepEqual(cases[0].tokens, { input: 10, output: 20, total: 30 });
  });

  describe('failIf thresholds', () => {
    it('throws EvalThresholdError when passRate < lt', async () => {
      const runner = new EvalRunner({
        target: failingTarget('boom'),
        dataset: ds(['a', 'b']),
        scorers: [alwaysPass],
        failIf: { passRate: { lt: 0.9 } },
      });
      await assert.rejects(() => runner.run(), EvalThresholdError);
    });

    it('throws when passRate <= lte (equal)', async () => {
      const runner = new EvalRunner({
        target: makeTarget('hi'),
        dataset: ds(['a']),
        scorers: [alwaysPass],
        failIf: { passRate: { lte: 1.0 } },
      });
      await assert.rejects(() => runner.run(), EvalThresholdError);
    });

    it('does not throw when threshold is satisfied', async () => {
      const runner = new EvalRunner({
        target: makeTarget('hi'),
        dataset: ds(['a']),
        scorers: [alwaysPass],
        failIf: { passRate: { lt: 0.5 } },
      });
      const report = await runner.run();
      assert.equal(report.passRate, 1);
    });

    it('includes the report on EvalThresholdError', async () => {
      const runner = new EvalRunner({
        target: failingTarget('boom'),
        dataset: ds(['a']),
        scorers: [alwaysPass],
        failIf: { passRate: { lt: 1 } },
      });
      try {
        await runner.run();
        assert.fail('expected EvalThresholdError');
      } catch (err) {
        assert.ok(err instanceof EvalThresholdError);
        assert.ok(err.report.total === 1);
        assert.ok(err.violations.length > 0);
      }
    });

    it('throws when scorer mean score < lt', async () => {
      const runner = new EvalRunner({
        target: makeTarget('hi'),
        dataset: ds(['a']),
        scorers: [alwaysFail],
        failIf: { scores: { fail: { lt: 0.5 } } },
      });
      await assert.rejects(() => runner.run(), EvalThresholdError);
    });
  });
});

// ---- EvalRunner.compare() ----

describe('EvalRunner.compare()', () => {
  it('returns a report for each named target', async () => {
    const dataset = ds(['input']);
    const targets = {
      alpha: makeTarget('response-a'),
      beta: makeTarget('response-b'),
    };
    const reports = await EvalRunner.compare(dataset, [alwaysPass], targets);
    assert.ok('alpha' in reports);
    assert.ok('beta' in reports);
    assert.equal(reports['alpha'].cases[0].output, 'response-a');
    assert.equal(reports['beta'].cases[0].output, 'response-b');
  });

  it('each target runs independently (separate pass rates)', async () => {
    const dataset = ds(['x']);
    const reports = await EvalRunner.compare(dataset, [alwaysPass, alwaysFail], {
      good: makeTarget('good'),
    });
    assert.equal(reports['good'].passed, 0); // alwaysFail makes it fail
  });
});

// ---- EvalRunner.rank() ----

describe('EvalRunner.rank()', () => {
  it('throws when fewer than 2 targets are provided', async () => {
    await assert.rejects(
      () => EvalRunner.rank({
        dataset: ds(['x']),
        targets: { only: makeTarget('hi') },
        judge: makeTarget('{}'),
        criteria: 'quality',
      }),
      /at least two/
    );
  });

  it('returns a leaderboard with all target names', async () => {
    const judge = {
      execute: async (prompt: string): Promise<string> => {
        const labels = [...prompt.matchAll(/^\[([A-Z])\]$/gm)].map((m) => m[1]);
        return JSON.stringify({ ranking: labels, reason: 'test' });
      },
    };
    const report = await EvalRunner.rank({
      dataset: ds(['question']),
      targets: { alpha: makeTarget('answer a'), beta: makeTarget('answer b') },
      judge,
      criteria: 'quality',
    });
    assert.equal(report.leaderboard.length, 2);
    const names = report.leaderboard.map((e) => e.name);
    assert.ok(names.includes('alpha'));
    assert.ok(names.includes('beta'));
  });

  it('total Borda points equals N_cases * N*(N-1)/2', async () => {
    const judge = {
      execute: async (prompt: string): Promise<string> => {
        const labels = [...prompt.matchAll(/^\[([A-Z])\]$/gm)].map((m) => m[1]);
        return JSON.stringify({ ranking: labels, reason: 'test' });
      },
    };
    const nCases = 3;
    const targets = { a: makeTarget('a'), b: makeTarget('b'), c: makeTarget('c') };
    const report = await EvalRunner.rank({
      dataset: ds(Array.from({ length: nCases }, (_, i) => `q${i}`)),
      targets,
      judge,
      criteria: 'quality',
    });
    const totalPoints = report.leaderboard.reduce((s, e) => s + e.points, 0);
    // For N=3, each case distributes 2+1+0=3 points; 3 cases → 9 total
    assert.equal(totalPoints, nCases * 3);
  });

  it('produces empty ranking for invalid judge response without crashing', async () => {
    const badJudge = makeTarget('not valid json at all');
    const report = await EvalRunner.rank({
      dataset: ds(['q']),
      targets: { x: makeTarget('x'), y: makeTarget('y') },
      judge: badJudge,
      criteria: 'quality',
    });
    assert.equal(report.cases[0].ranking.length, 0);
    assert.equal(report.leaderboard.length, 2);
  });
});
