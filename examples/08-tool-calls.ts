/**
 * Tool-calling example — no API key required.
 *
 * Evaluating a tool-using agent isn't just about the final text — it's about
 * *which tools it called, with what arguments, in what order*. The runner reads
 * the tool-call trace from any target that exposes getHistoryEntries() (every
 * Agention agent does) and hands it to scorers.
 *
 * Here the target is a fake agent that mimics that surface: it records its tool
 * calls as `tool_use` history entries, exactly like a real ClaudeAgent. Swap it
 * for a real agent with tools and the same scorers apply unchanged.
 *
 * Demonstrates:
 *  - Scorer.toolCalls: assert tools + arguments, ordered or unordered
 *  - Scorer.custom reading context.toolCalls
 *  - tool calls surfaced on EvalCaseResult and in the report
 */
import assert from 'node:assert';
import { EvalDataset, EvalRunner, Scorer, formatReport } from '../src';

// A stand-in for a real tool-using agent. `execute()` returns a string and
// records the tools it "called" as tool_use history entries — the same shape
// BaseAgent.getHistoryEntries() returns.
class FakeToolAgent {
  private lastEntries: Array<{ role: string; content: unknown[] }> = [];

  async execute(input: string): Promise<string> {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];

    if (input.includes('weather')) {
      calls.push({ name: 'get_weather', input: { city: 'Paris' } });
    } else if (input.includes('flight')) {
      calls.push({ name: 'search_flights', input: { from: 'SFO', to: 'JFK' } });
      calls.push({ name: 'book_flight', input: { flightId: 'UA123' } });
    } else {
      // No tool used — just answers directly.
    }

    this.lastEntries = [
      {
        role: 'assistant',
        content: calls.map((c, i) => ({
          type: 'tool_use',
          id: `call_${i}`,
          name: c.name,
          input: c.input,
        })),
      },
    ];

    return calls.length ? `Done. Used: ${calls.map((c) => c.name).join(', ')}` : 'No tools needed.';
  }

  getHistoryEntries() {
    return this.lastEntries;
  }
}

const dataset = new EvalDataset([
  { input: 'What is the weather in Paris?', metadata: { kind: 'weather' } },
  { input: 'Book me a flight from SFO to JFK', metadata: { kind: 'travel' } },
]);

const runner = new EvalRunner({
  target: new FakeToolAgent(),
  dataset,
  scorers: [
    // Unordered set match with argument assertions. The case-level `expected`
    // is unused here — the expected tools live in the scorer itself, so the
    // same scorer can't apply to both cases. Use per-target scorers or a custom
    // scorer when expectations differ per case; here we assert the union loosely
    // via a custom scorer instead:
    Scorer.custom('expectedToolForKind', async (_output, _expected, input, context) => {
      const calls = context?.toolCalls ?? [];
      const names = calls.map((c) => c.name);
      const ok = String(input).includes('weather')
        ? names.includes('get_weather')
        : names.includes('book_flight');
      return {
        pass: ok,
        score: ok ? 1 : 0,
        reason: ok ? undefined : `unexpected tools: [${names.join(', ')}]`,
        scorerName: 'expectedToolForKind',
      };
    }),

    // A guard that applies to every case: no destructive tools were called.
    Scorer.custom('noDeletes', async (_output, _expected, _input, context) => {
      const deleted = (context?.toolCalls ?? []).some((c) => c.name.startsWith('delete_'));
      return { pass: !deleted, score: deleted ? 0 : 1, scorerName: 'noDeletes' };
    }),
  ],
  onCaseComplete(result, index) {
    const tools = result.toolCalls?.map((t) => t.name).join(', ') || '(none)';
    console.log(`  [${index + 1}] ${result.pass ? 'PASS' : 'FAIL'}  tools: ${tools}`);
  },
});

runner.run().then((report) => {
  console.log(formatReport(report));

  // Both cases call the right tool for their kind, and none delete anything.
  assert.strictEqual(report.passed, 2);

  // The travel case is an ordered, exact tool sequence — verify it directly.
  const travel = report.cases.find((c) => c.case.metadata?.kind === 'travel');
  assert.deepStrictEqual(
    travel?.toolCalls?.map((t) => t.name),
    ['search_flights', 'book_flight']
  );

  // And Scorer.toolCalls itself, against the captured trace:
  const ordered = Scorer.toolCalls(['search_flights', 'book_flight'], {
    ordered: true,
    allowExtra: false,
  });
  ordered
    .score('', undefined, '', { toolCalls: travel!.toolCalls! })
    .then((r) => {
      assert.strictEqual(r.pass, true);
      console.log('Assertions passed.');
    })
    .catch(console.error);
}).catch(console.error);
