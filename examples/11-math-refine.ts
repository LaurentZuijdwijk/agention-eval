/**
 * Math refinement example — requires ANTHROPIC_API_KEY.
 *
 * Runs tricky math word problems through EvalRunner.refine() with claude-haiku.
 * Each problem is a "trap" where the obvious shortcut gives a plausible but
 * wrong answer (e.g. averaging rates instead of using the harmonic mean).
 *
 * Round 0: generate beamWidth=3 independent attempts, pick the best-scoring one.
 * Round 1: feed that attempt's reasoning back so the model can self-correct.
 *
 * The reasoning field is the key — feeding back chain-of-thought (not just the
 * answer) lets the model spot the step where it went wrong.
 *
 * Run: node --import tsx examples/11-math-refine.ts
 */
import 'dotenv/config';
import { ClaudeAgent } from '@agentionai/agents/claude';
import { EvalDataset, EvalRunner, Scorer, formatReport } from '../src';

const baseConfig = {
  name: 'Math Solver',
  description: [
    'You are a precise mathematical problem solver.',
    'Work through each problem step by step.',
    'Return ONLY a JSON object — no prose, no markdown fences:',
    '{"answer": <number>, "reasoning": "<concise step-by-step explanation>"}',
    'answer must be a plain number (use decimals, not fractions). Round to 2 decimal places if needed.',
  ].join('\n'),
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
};

// Three agents at different temperatures — low keeps it precise, high encourages
// exploring alternative approaches. Cycling across beam slots gives real variation
// rather than three nearly-identical samples from the same distribution.
const solvers = [
  new ClaudeAgent({ ...baseConfig, id: 'solver-precise', temperature: 0.2 }),
  new ClaudeAgent({ ...baseConfig, id: 'solver-balanced', temperature: 0.7 }),
  new ClaudeAgent({ ...baseConfig, id: 'solver-creative', temperature: 1.0 }),
];

// --- Scorer ---

function parseAnswer(output: string): number | null {
  try {
    const cleaned = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const n = JSON.parse(cleaned)?.answer;
    const parsed = typeof n === 'number' ? n : parseFloat(n);
    return isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

const numericAccuracy = Scorer.custom('numeric', async (output, expected) => {
  const actual = parseAnswer(output);
  const target = expected as number;
  if (actual === null) {
    return { pass: false, score: 0, reason: `unparseable: ${output.slice(0, 80)}`, scorerName: 'numeric' };
  }
  // 0.5% relative tolerance + small absolute floor to handle near-zero answers
  const tol = Math.abs(target) * 0.005 + 0.01;
  const pass = Math.abs(actual - target) <= tol;
  // Partial score: 1 at exact, decays toward 0 as error grows
  const score = pass ? 1 : Math.max(0, 1 - Math.abs(actual - target) / (Math.abs(target) + 1));
  return { pass, score, reason: pass ? undefined : `expected ${target}, got ${actual}`, scorerName: 'numeric' };
});

// --- Dataset: multi-step problems that require careful equation setup ---
// Chosen because they require multiple dependent steps, not just one formula.
// Small errors early (wrong rate, wrong remaining fraction) cascade badly.

const dataset = new EvalDataset([
  {
    name: 'work handoff — B alone then A joins',
    input: [
      'Machines A and B together finish a job in 12 days.',
      'Machine A alone takes 20 days.',
      'Machine B works alone for 6 days, then A joins B and they finish together.',
      'How many days in total does the job take? Give the answer as a decimal.',
    ].join(' '),
    // B rate = 1/30; B does 6/30=1/5; remaining 4/5 at combined rate 1/12 → 9.6 days → total 15.6
    expected: 15.6,
  },
  {
    name: 'mixture — remove and replace to hit target ratio',
    input: [
      'A 40-litre container holds milk and water in a 3:1 ratio.',
      'Some of the mixture is removed and replaced with the same volume of pure water,',
      'changing the ratio to 3:2.',
      'How many litres were removed and replaced?',
    ].join(' '),
    // (30 - 3x/4) / (10 + 3x/4) = 3/2  →  x = 8
    expected: 8,
  },
  {
    name: 'compound interest with mid-term deposit',
    input: [
      '$3000 is invested at 5% annual compound interest.',
      'At the end of year 2, an additional $1000 is deposited.',
      'What is the total value at the end of year 3? Round to 2 decimal places.',
    ].join(' '),
    // Year 2: 3000×1.05²=3307.50; add 1000 → 4307.50; Year 3: ×1.05 = 4522.875
    expected: +(3000 * 1.05 ** 2 * 1.05 + 1000 * 1.05).toFixed(2), // 4522.88
  },
  {
    name: 'reverse compound growth — find starting population',
    input: [
      'A city population grows at exactly 4% per year.',
      'In 2020 the population was 500,000.',
      'What was the population in 2015? Round to the nearest whole number.',
    ].join(' '),
    // 500000 / 1.04^5 — trap: multiplying instead of dividing gives 608,326
    expected: Math.round(500000 / 1.04 ** 5), // 410,960
  },
  {
    name: 'quadratic speed — find rate from time saving',
    input: [
      'A train travels 450 km at a constant speed.',
      'If the speed were 15 km/h faster, the journey would take 1.5 hours less.',
      'What is the actual speed of the train in km/h?',
    ].join(' '),
    // 450/v − 450/(v+15) = 1.5  →  v²+15v−4500=0  →  v=60
    expected: 60,
  },
]);

// Three prompt framings to encourage genuinely different solution paths.
// Slot 0 (precise agent): direct.
// Slot 1 (balanced agent): equation-first — write the formula before substituting.
// Slot 2 (creative agent): error-check — anticipate the common mistake first.
const beamPrompts = [
  (input: string) => input,
  (input: string) =>
    `${input}\n\nApproach: start by writing the key equation or formula, then substitute values.`,
  (input: string) =>
    `${input}\n\nApproach: identify the most common mistake for this type of problem, then solve carefully avoiding it.`,
];

// --- Run ---

EvalRunner.refine({
  dataset,
  // Three agents at different temperatures — low stays precise, high explores
  // alternative approaches. Cycling across beam slots gives real variation
  // rather than three nearly-identical samples from the same distribution.
  target: solvers,
  scorers: [numericAccuracy],
  rounds: 2,
  beamWidth: 3,
  buildBeamInput: (input, beamIndex) =>
    beamPrompts[beamIndex % beamPrompts.length](input as string) as typeof input,
  // Feed the best attempt's reasoning back so the model can spot its own errors.
  // Using reasoning (not just the answer) is what makes self-correction possible.
  buildInput: (original, [best]) => {
    let reasoning: string;
    try {
      const cleaned = best.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      reasoning = JSON.parse(cleaned)?.reasoning ?? best;
    } catch {
      reasoning = best;
    }
    return [
      original,
      '',
      'Your previous attempt:',
      reasoning,
      '',
      'Review each step carefully. Identify any errors and correct them.',
      'Return the corrected JSON with your final answer.',
    ].join('\n');
  },
  // concurrency: 1 keeps cases sequential; beamWidth candidates within each
  // case still run in parallel (3 concurrent API calls per case per round).
  concurrency: 1,
  onRoundComplete(round, report) {
    console.log(`\nRound ${round + 1}: ${report.passed}/${report.total} passed`);
    for (const c of report.cases) {
      const got = parseAnswer(c.output);
      const status = c.pass ? '✓' : '✗';
      console.log(`  ${status} ${c.case.name}: got ${got ?? '?'} (expected ${c.case.expected})`);
    }
  },
})
  .then((report) => {
    console.log('\n--- Final report ---');
    console.log(formatReport(report.final));
    console.log(`Improvement: ${report.improvement >= 0 ? '+' : ''}${(report.improvement * 100).toFixed(0)}pp pass rate`);
  })
  .catch(console.error);
