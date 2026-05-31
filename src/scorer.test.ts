import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Scorer } from './scorer';
import type { ScorerContext } from './types';

const ctx = (toolCalls: ScorerContext['toolCalls'] = []): ScorerContext => ({ toolCalls });

const mockJudge = (response: string) => ({
  execute: async (_: never): Promise<string> => response,
});

const failingJudge = (msg: string) => ({
  execute: async (_: never): Promise<never> => { throw new Error(msg); },
});

// ---- Scorer.contains ----

describe('Scorer.contains', () => {
  it('passes when all keywords present', async () => {
    const r = await Scorer.contains(['hello', 'world']).score('hello world', undefined, '');
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
    assert.equal(r.scorerName, 'contains');
    assert.equal(r.reason, undefined);
  });

  it('fails when a keyword is missing', async () => {
    const r = await Scorer.contains(['hello', 'missing']).score('hello world', undefined, '');
    assert.equal(r.pass, false);
    assert.equal(r.score, 0.5);
    assert.ok(r.reason?.includes('missing'));
  });

  it('fails when no keywords are present', async () => {
    const r = await Scorer.contains(['foo', 'bar']).score('hello world', undefined, '');
    assert.equal(r.pass, false);
    assert.equal(r.score, 0);
  });

  it('is case-insensitive by default', async () => {
    const r = await Scorer.contains(['HELLO', 'World']).score('hello world', undefined, '');
    assert.equal(r.pass, true);
  });

  it('is case-sensitive when caseSensitive: true', async () => {
    const r = await Scorer.contains(['HELLO'], { caseSensitive: true }).score('hello world', undefined, '');
    assert.equal(r.pass, false);
  });

  it('passes with exact case when caseSensitive: true', async () => {
    const r = await Scorer.contains(['HELLO'], { caseSensitive: true }).score('HELLO world', undefined, '');
    assert.equal(r.pass, true);
  });

  it('computes fractional score correctly', async () => {
    const r = await Scorer.contains(['a', 'b', 'c']).score('a b', undefined, '');
    assert.equal(r.pass, false);
    assert.ok(Math.abs(r.score - 2 / 3) < 1e-9);
  });

  it('passes with empty keywords list and gives score of 1', async () => {
    const r = await Scorer.contains([]).score('anything', undefined, '');
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
  });
});

// ---- normalizeValue / valuesEqual (tested through fieldAccuracy and exactMatch) ----

describe('value normalization', () => {
  const fa = (output: unknown, expected: unknown) =>
    Scorer.fieldAccuracy(['v']).score(
      JSON.stringify({ v: output }),
      { v: expected },
      ''
    );

  it('strips currency symbol and parses number', async () => {
    const r = await fa('$1,250.00', 1250);
    assert.equal(r.pass, true);
  });

  it('handles European number format (1.250,00)', async () => {
    const r = await fa('1.250,00', 1250);
    assert.equal(r.pass, true);
  });

  it('normalizes "yes" to boolean true', async () => {
    const r = await fa('yes', true);
    assert.equal(r.pass, true);
  });

  it('normalizes "no" to boolean false', async () => {
    const r = await fa('no', false);
    assert.equal(r.pass, true);
  });

  it('normalizes "true" and "false" strings', async () => {
    assert.equal((await fa('true', true)).pass, true);
    assert.equal((await fa('false', false)).pass, true);
  });

  it('normalizes "1" to boolean true and coerces against number 1', async () => {
    // "1" → boolean true, and boolean true coerces to 1 for numeric comparison
    const r = await fa('1', 1);
    assert.equal(r.pass, true);
  });

  it('normalizes "0" to boolean false and coerces against number 0', async () => {
    const r = await fa('0', 0);
    assert.equal(r.pass, true);
  });

  it('strips trailing percent and returns numeric value', async () => {
    const r = await fa('50%', 50);
    assert.equal(r.pass, true);
  });

  it('does case-insensitive string comparison', async () => {
    const r = await fa('Paris', 'paris');
    assert.equal(r.pass, true);
  });

  it('returns null for null and matches null expected', async () => {
    const r = await fa(null, null);
    assert.equal(r.pass, true);
  });

  it('does not match null actual against non-null expected', async () => {
    const r = await fa(null, 'something');
    assert.equal(r.pass, false);
  });
});

// ---- Scorer.exactMatch ----

describe('Scorer.exactMatch', () => {
  it('passes when all fields match', async () => {
    const r = await Scorer.exactMatch().score(
      JSON.stringify({ a: 'hello', b: 42 }),
      { a: 'hello', b: 42 },
      ''
    );
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
  });

  it('fails for non-JSON output', async () => {
    const r = await Scorer.exactMatch().score('not json', { a: 1 }, '');
    assert.equal(r.pass, false);
    assert.equal(r.score, 0);
    assert.ok(r.reason?.includes('not valid JSON'));
  });

  it('fails when expected is not an object', async () => {
    const r = await Scorer.exactMatch().score(JSON.stringify({ a: 1 }), 'string', '');
    assert.equal(r.pass, false);
    assert.equal(r.score, 0);
  });

  it('fails and reports mismatched fields', async () => {
    const r = await Scorer.exactMatch().score(
      JSON.stringify({ a: 'wrong', b: 42 }),
      { a: 'hello', b: 42 },
      ''
    );
    assert.equal(r.pass, false);
    assert.equal(r.score, 0.5);
    assert.ok(r.reason?.includes('a'));
  });

  it('checks only specified field subset', async () => {
    const r = await Scorer.exactMatch(['b']).score(
      JSON.stringify({ a: 'wrong', b: 42 }),
      { a: 'hello', b: 42 },
      ''
    );
    assert.equal(r.pass, true);
  });

  it('parses markdown-fenced JSON', async () => {
    const r = await Scorer.exactMatch().score(
      '```json\n{"a": 1}\n```',
      { a: 1 },
      ''
    );
    assert.equal(r.pass, true);
  });

  it('passes with empty fields list and gives score of 1', async () => {
    const r = await Scorer.exactMatch([]).score(JSON.stringify({ a: 1 }), { a: 99 }, '');
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
  });
});

// ---- Scorer.fieldAccuracy ----

describe('Scorer.fieldAccuracy', () => {
  it('passes when all fields match', async () => {
    const r = await Scorer.fieldAccuracy(['amount', 'currency']).score(
      JSON.stringify({ amount: 1250, currency: 'USD' }),
      { amount: 1250, currency: 'USD' },
      ''
    );
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
    assert.equal(r.scorerName, 'fieldAccuracy');
  });

  it('extracts number from currency string', async () => {
    const r = await Scorer.fieldAccuracy(['amount']).score(
      JSON.stringify({ amount: '$1,250.00' }),
      { amount: 1250 },
      ''
    );
    assert.equal(r.pass, true);
  });

  it('handles boolean string "yes"', async () => {
    const r = await Scorer.fieldAccuracy(['active']).score(
      JSON.stringify({ active: 'Yes' }),
      { active: true },
      ''
    );
    assert.equal(r.pass, true);
  });

  it('accepts values within numeric tolerance', async () => {
    const r = await Scorer.fieldAccuracy(['v'], { tolerance: 0.05 }).score(
      JSON.stringify({ v: 100 }),
      { v: 104 },
      ''
    );
    assert.equal(r.pass, true);
  });

  it('rejects values outside numeric tolerance', async () => {
    const r = await Scorer.fieldAccuracy(['v'], { tolerance: 0.05 }).score(
      JSON.stringify({ v: 100 }),
      { v: 120 },
      ''
    );
    assert.equal(r.pass, false);
  });

  it('fails for non-JSON output', async () => {
    const r = await Scorer.fieldAccuracy(['v']).score('not json', { v: 1 }, '');
    assert.equal(r.pass, false);
    assert.ok(r.reason?.includes('not valid JSON'));
  });

  it('fails when expected is not an object', async () => {
    const r = await Scorer.fieldAccuracy(['v']).score(JSON.stringify({ v: 1 }), null, '');
    assert.equal(r.pass, false);
  });

  it('computes fractional score', async () => {
    const r = await Scorer.fieldAccuracy(['a', 'b', 'c']).score(
      JSON.stringify({ a: 1, b: 99, c: 3 }),
      { a: 1, b: 2, c: 3 },
      ''
    );
    assert.equal(r.pass, false);
    assert.ok(Math.abs(r.score - 2 / 3) < 1e-9);
  });

  it('passes with empty fields list and gives score of 1', async () => {
    const r = await Scorer.fieldAccuracy([]).score(JSON.stringify({ a: 1 }), { a: 99 }, '');
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
  });
});

// ---- Scorer.jsonSchema ----

describe('Scorer.jsonSchema', () => {
  const zodSchema = z.object({ name: z.string(), age: z.number() });

  it('passes valid output against Zod schema', async () => {
    const r = await Scorer.jsonSchema(zodSchema).score(
      JSON.stringify({ name: 'Alice', age: 30 }),
      undefined,
      ''
    );
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
    assert.equal(r.scorerName, 'jsonSchema');
  });

  it('fails invalid output against Zod schema with reasons', async () => {
    const r = await Scorer.jsonSchema(zodSchema).score(
      JSON.stringify({ name: 'Alice', age: 'not-a-number' }),
      undefined,
      ''
    );
    assert.equal(r.pass, false);
    assert.equal(r.score, 0);
    assert.ok(r.reason && r.reason.length > 0);
  });

  it('fails non-JSON output', async () => {
    const r = await Scorer.jsonSchema(zodSchema).score('not json', undefined, '');
    assert.equal(r.pass, false);
    assert.ok(r.reason?.includes('not valid JSON'));
  });

  it('parses markdown-fenced JSON for Zod schema', async () => {
    const r = await Scorer.jsonSchema(zodSchema).score(
      '```json\n{"name":"Bob","age":25}\n```',
      undefined,
      ''
    );
    assert.equal(r.pass, true);
  });

  it('passes plain JSON schema type check', async () => {
    const schema = { type: 'object', required: ['id'], properties: { id: { type: 'number' } } };
    const r = await Scorer.jsonSchema(schema).score(JSON.stringify({ id: 1 }), undefined, '');
    assert.equal(r.pass, true);
  });

  it('fails plain JSON schema when required field is missing', async () => {
    const schema = { type: 'object', required: ['id', 'name'] };
    const r = await Scorer.jsonSchema(schema).score(JSON.stringify({ id: 1 }), undefined, '');
    assert.equal(r.pass, false);
    assert.ok(r.reason?.includes('name'));
  });

  it('fails plain JSON schema on wrong property type', async () => {
    const schema = { type: 'object', properties: { id: { type: 'number' } } };
    const r = await Scorer.jsonSchema(schema).score(JSON.stringify({ id: 'abc' }), undefined, '');
    assert.equal(r.pass, false);
  });

  it('fails plain JSON schema when root type is wrong', async () => {
    const schema = { type: 'array' };
    const r = await Scorer.jsonSchema(schema).score(JSON.stringify({ a: 1 }), undefined, '');
    assert.equal(r.pass, false);
    assert.ok(r.reason?.includes('array'));
  });
});

// ---- Scorer.toolCalls ----

describe('Scorer.toolCalls', () => {
  const call = (name: string, input: Record<string, unknown> = {}) => ({ name, input });

  it('passes when all expected tools are called (unordered)', async () => {
    const r = await Scorer.toolCalls(['search', 'fetch']).score(
      '', undefined, '',
      ctx([call('fetch'), call('search')])
    );
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
    assert.equal(r.scorerName, 'toolCalls');
  });

  it('fails when an expected tool is missing', async () => {
    const r = await Scorer.toolCalls(['search', 'missing']).score(
      '', undefined, '',
      ctx([call('search')])
    );
    assert.equal(r.pass, false);
    assert.ok(r.reason?.includes('missing'));
    assert.equal(r.score, 0.5);
  });

  it('allows extra calls by default (allowExtra: true)', async () => {
    const r = await Scorer.toolCalls(['search']).score(
      '', undefined, '',
      ctx([call('search'), call('extra')])
    );
    assert.equal(r.pass, true);
  });

  it('fails on unexpected extra calls when allowExtra: false', async () => {
    const r = await Scorer.toolCalls(['search'], { allowExtra: false }).score(
      '', undefined, '',
      ctx([call('search'), call('extra')])
    );
    assert.equal(r.pass, false);
    assert.ok(r.reason?.includes('extra'));
  });

  it('passes ordered subsequence in correct order', async () => {
    const r = await Scorer.toolCalls(['a', 'b', 'c'], { ordered: true }).score(
      '', undefined, '',
      ctx([call('a'), call('b'), call('c')])
    );
    assert.equal(r.pass, true);
  });

  it('fails ordered when calls are out of order', async () => {
    const r = await Scorer.toolCalls(['a', 'c'], { ordered: true }).score(
      '', undefined, '',
      ctx([call('c'), call('a')])
    );
    assert.equal(r.pass, false);
  });

  it('matches partial input arguments', async () => {
    const r = await Scorer.toolCalls([{ name: 'search', input: { query: 'hello' } }]).score(
      '', undefined, '',
      ctx([call('search', { query: 'hello', extra: 'ignored' })])
    );
    assert.equal(r.pass, true);
  });

  it('fails when expected input argument does not match', async () => {
    const r = await Scorer.toolCalls([{ name: 'search', input: { query: 'expected' } }]).score(
      '', undefined, '',
      ctx([call('search', { query: 'different' })])
    );
    assert.equal(r.pass, false);
  });

  it('treats missing context as empty tool calls', async () => {
    const r = await Scorer.toolCalls(['search']).score('', undefined, '');
    assert.equal(r.pass, false);
  });

  it('passes with no expected tools and no actual calls (score=1)', async () => {
    const r = await Scorer.toolCalls([]).score('', undefined, '', ctx([]));
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
  });

  it('fails with no expected tools but extra calls when allowExtra: false', async () => {
    const r = await Scorer.toolCalls([], { allowExtra: false }).score(
      '', undefined, '',
      ctx([call('surprise')])
    );
    assert.equal(r.pass, false);
    assert.equal(r.score, 0);
  });
});

// ---- Scorer.llm ----

describe('Scorer.llm', () => {
  it('normalizes score from 1-to-5 scale to 0-1', async () => {
    const r = await Scorer.llm(mockJudge('{"score":3,"reason":"ok"}'), { criteria: 'quality' })
      .score('output', undefined, 'input');
    assert.ok(Math.abs(r.score - 0.5) < 1e-9); // (3-1)/(5-1) = 0.5
    assert.equal(r.scorerName, 'llm');
  });

  it('maps minimum score (1) to 0', async () => {
    const r = await Scorer.llm(mockJudge('{"score":1,"reason":"poor"}'), { criteria: 'c' })
      .score('output', undefined, 'input');
    assert.equal(r.score, 0);
    assert.equal(r.pass, false);
  });

  it('maps maximum score (scale) to 1', async () => {
    const r = await Scorer.llm(mockJudge('{"score":5,"reason":"great"}'), { criteria: 'c' })
      .score('output', undefined, 'input');
    assert.equal(r.score, 1);
    assert.equal(r.pass, true);
  });

  it('passes when normalised score >= passingScore', async () => {
    // score=4 on scale=5 → (4-1)/4 = 0.75. passingScore default is 0.6
    const r = await Scorer.llm(mockJudge('{"score":4,"reason":"good"}'), { criteria: 'c' })
      .score('output', undefined, 'input');
    assert.equal(r.pass, true);
  });

  it('respects custom passingScore threshold', async () => {
    // score=4 → 0.75; passingScore=0.8 → fail
    const r = await Scorer.llm(mockJudge('{"score":4,"reason":"good"}'), { criteria: 'c', passingScore: 0.8 })
      .score('output', undefined, 'input');
    assert.equal(r.pass, false);
  });

  it('respects custom scale', async () => {
    // score=7 on scale=10 → (7-1)/9 ≈ 0.667
    const r = await Scorer.llm(mockJudge('{"score":7,"reason":"ok"}'), { criteria: 'c', scale: 10 })
      .score('output', undefined, 'input');
    assert.ok(Math.abs(r.score - 6 / 9) < 1e-9);
  });

  it('fails gracefully when judge throws', async () => {
    const r = await Scorer.llm(failingJudge('network error'), { criteria: 'c' })
      .score('output', undefined, 'input');
    assert.equal(r.pass, false);
    assert.equal(r.score, 0);
    assert.ok(r.reason?.includes('network error'));
  });

  it('fails when judge returns unparseable output', async () => {
    const r = await Scorer.llm(mockJudge('not json at all'), { criteria: 'c' })
      .score('output', undefined, 'input');
    assert.equal(r.pass, false);
    assert.equal(r.score, 0);
    assert.ok(r.reason?.includes('parse'));
  });

  it('accepts markdown-fenced JSON from judge', async () => {
    const r = await Scorer.llm(mockJudge('```json\n{"score":5,"reason":"great"}\n```'), { criteria: 'c' })
      .score('output', undefined, 'input');
    assert.equal(r.pass, true);
    assert.equal(r.score, 1);
  });
});

// ---- Scorer.custom ----

describe('Scorer.custom', () => {
  it('calls the function and overwrites scorerName', async () => {
    const s = Scorer.custom('my-scorer', async (output, expected, input) => ({
      pass: output === 'yes',
      score: output === 'yes' ? 1 : 0,
      scorerName: 'will-be-overwritten',
    }));
    const r = await s.score('yes', undefined, '');
    assert.equal(r.pass, true);
    assert.equal(r.scorerName, 'my-scorer');
  });

  it('passes context through to the function', async () => {
    let receivedContext: ScorerContext | undefined;
    const s = Scorer.custom('ctx-test', async (_o, _e, _i, context) => {
      receivedContext = context;
      return { pass: true, score: 1, scorerName: 'ctx-test' };
    });
    const context = ctx([{ name: 'tool', input: {} }]);
    await s.score('', undefined, '', context);
    assert.deepEqual(receivedContext, context);
  });
});
