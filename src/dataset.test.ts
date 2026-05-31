import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalDataset } from './dataset';

describe('EvalDataset', () => {
  it('fromArray maps items to EvalCases', () => {
    const ds = EvalDataset.fromArray([1, 2, 3], (n) => ({ input: String(n), expected: n * 2 }));
    assert.equal(ds.size, 3);
    assert.deepEqual(ds.cases[0], { input: '1', expected: 2 });
    assert.deepEqual(ds.cases[2], { input: '3', expected: 6 });
  });

  it('exposes cases via getter', () => {
    const ds = new EvalDataset([{ input: 'a' }, { input: 'b' }]);
    assert.equal(ds.cases.length, 2);
    assert.equal(ds.cases[1].input, 'b');
  });

  it('reports correct size', () => {
    const ds = new EvalDataset([{ input: 'x' }, { input: 'y' }, { input: 'z' }]);
    assert.equal(ds.size, 3);
  });

  it('handles an empty dataset', () => {
    const ds = new EvalDataset([]);
    assert.equal(ds.size, 0);
    assert.deepEqual(ds.cases, []);
  });

  it('fromArray handles empty items', () => {
    const ds = EvalDataset.fromArray([], (n: number) => ({ input: String(n) }));
    assert.equal(ds.size, 0);
  });

  it('fromJsonl parses a JSONL file', async () => {
    const path = join(tmpdir(), `eval-test-${Date.now()}.jsonl`);
    const lines = [
      { input: 'hello', expected: 'world' },
      { input: 'foo', expected: 'bar', name: 'my case' },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));

    const ds = await EvalDataset.fromJsonl<string>(path);
    assert.equal(ds.size, 2);
    assert.equal(ds.cases[0].input, 'hello');
    assert.equal(ds.cases[0].expected, 'world');
    assert.equal(ds.cases[1].name, 'my case');
  });

  it('fromJsonl ignores blank lines', async () => {
    const path = join(tmpdir(), `eval-test-blank-${Date.now()}.jsonl`);
    writeFileSync(path, `{"input":"a"}\n\n{"input":"b"}\n`);
    const ds = await EvalDataset.fromJsonl<string>(path);
    assert.equal(ds.size, 2);
  });
});
