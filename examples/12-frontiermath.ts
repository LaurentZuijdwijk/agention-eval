/**
 * FrontierMath Tier 1 — refinement loop with Haiku.
 *
 * Three problems from Epoch AI's FrontierMath benchmark (Tier 1, the "easiest"
 * tier). These are designed to defeat frontier models, so exact passes are
 * unlikely. Two scorers run in parallel:
 *
 *   exact     — numeric match within 0.5%: did the answer land?
 *   llm       — Haiku judge (1–5 scale): did the *reasoning* improve across
 *               rounds even when the final number is wrong?
 *
 * The llm scorer is the more interesting signal here — it shows whether the
 * refinement loop helps the model converge on the right approach even if it
 * never computes the exact answer.
 *
 * Run: node --import tsx examples/12-frontiermath.ts
 */
import 'dotenv/config';
import { ClaudeAgent } from '@agentionai/agents/claude';
import { EvalDataset, EvalRunner, Scorer, formatReport } from '../src';

const baseConfig = {
  name: 'Math Solver',
  description: [
    'You are a research mathematician with expertise in algebraic geometry, combinatorics, and number theory.',
    'Solve the given problem rigorously. Show your full reasoning.',
    'Return ONLY a JSON object — no prose, no markdown fences:',
    '{"answer": <integer>, "reasoning": "<full step-by-step solution>"}',
    'answer must be a plain integer. Do not use scientific notation.',
  ].join('\n'),
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-6',
  maxTokens: 4096,
};

// Three temperatures for genuine beam diversity
const solvers = [
  new ClaudeAgent({ ...baseConfig, id: 'solver-precise',  temperature: 0.2 }),
  new ClaudeAgent({ ...baseConfig, id: 'solver-balanced', temperature: 0.7 }),
  new ClaudeAgent({ ...baseConfig, id: 'solver-creative', temperature: 1.0 }),
];

// Haiku as a cheap judge — we care about reasoning quality, not just the answer
const judge = new ClaudeAgent({
  id: 'math-judge',
  name: 'Math Judge',
  description: 'You evaluate mathematical solutions for correctness of approach and reasoning quality.',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
});

// --- Scorers ---

function parseAnswer(output: string): number | null {
  // 1. Try the whole output as JSON (clean case)
  try {
    const cleaned = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const raw = JSON.parse(cleaned)?.answer;
    if (raw !== undefined) {
      const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, ''));
      if (!isNaN(n)) return n;
    }
  } catch {}

  // 2. Find "answer": <number> anywhere in the output (handles verbose multi-line reasoning)
  const m = output.match(/"answer"\s*:\s*(-?[\d,]+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(n)) return n;
  }

  return null;
}

const exactAccuracy = Scorer.custom('exact', async (output, expected) => {
  const actual = parseAnswer(output);
  const target = expected as number;
  if (actual === null) {
    return { pass: false, score: 0, reason: 'unparseable output', scorerName: 'exact' };
  }
  const tol = Math.abs(target) * 0.005 + 0.5;
  const pass = Math.abs(actual - target) <= tol;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? undefined : `expected ${target}, got ${actual}`,
    scorerName: 'exact',
  };
});

const reasoningJudge = Scorer.llm(judge, {
  criteria:
    'Does the solver correctly identify the mathematical domain (e.g. algebraic geometry, ' +
    'group theory, combinatorics) and the key theorems needed? Is the overall approach sound? ' +
    'Are the intermediate steps logically consistent with the approach? ' +
    'Score higher for correct framework even if the arithmetic is wrong.',
  scale: 5,
  passingScore: 0.6, // 3 out of 5
});

// --- Dataset: FrontierMath Tier 1 ---
// Source: https://epoch.ai/frontiermath/tiers-1-4/benchmark-problems#tier-1

const dataset = new EvalDataset([
  {
    name: 'Klein quartic over 𝔽_{5^18}',
    input: [
      'Count the number of nonzero projective points (x : y : z),',
      'i.e. points with (x,y,z) ≠ (0,0,0) considered up to scalar in 𝔽_{5^18}*,',
      'lying on the projective curve C defined by x³y + y³z + z³x = 0',
      'over the finite field 𝔽_{5^18} (the field with 5^18 elements).',
      'Give the exact integer count.',
    ].join(' '),
    expected: 3814708984376,
  },
  {
    name: 'Expected perimeter — random diagonals of 101-gon',
    input: [
      'Consider a regular 101-gon with vertices on the unit circle.',
      'Each of its diagonals (line segments connecting non-adjacent vertices)',
      'is independently included with probability p = 0.001.',
      'Let E be the expected perimeter of the convex hull of the set of included diagonals',
      'that contains the center of the polygon.',
      'If no included diagonals enclose the center, treat the contribution as 0.',
      'Compute ⌊10⁹ × E⌋ as an integer.',
    ].join(' '),
    expected: 4771880153,
  },
  {
    name: 'Orbit counting — involution 4-tuples over 𝔽₂',
    input: [
      'Let S be the set of ordered 4-tuples (A, B, C, D) of 2×2 invertible matrices over 𝔽₂',
      'satisfying: (i) each matrix is an involution (M² = I),',
      '(ii) the pairs (A,B), (A,C), (B,D), (C,D) each commute,',
      '(iii) A and D do not commute (AD ≠ DA).',
      'The group G = GL(2, 𝔽₂) acts on S by simultaneous conjugation:',
      'g · (A,B,C,D) = (gAg⁻¹, gBg⁻¹, gCg⁻¹, gDg⁻¹).',
      'Find |S/G|, the number of orbits of this action.',
    ].join(' '),
    expected: 625243878951,
  },
]);

// --- Beam prompt variation ---

const beamPrompts = [
  (input: string) => input,
  (input: string) =>
    `${input}\n\nApproach: first name the mathematical framework and the key theorem or formula you will use, then carry out the computation step by step.`,
  (input: string) =>
    `${input}\n\nApproach: think about which classical results apply (e.g. Weil conjectures, Burnside's lemma, linearity of expectation, character theory). State the result you are using before applying it.`,
];

// --- Run ---

EvalRunner.refine({
  dataset,
  target: solvers,
  scorers: [exactAccuracy, reasoningJudge],
  rounds: 3,
  beamWidth: 3,
  buildBeamInput: (input, beamIndex) =>
    beamPrompts[beamIndex % beamPrompts.length](input as string) as typeof input,
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
      'Your previous best attempt:',
      reasoning,
      '',
      'If the approach was correct, check every arithmetic step carefully.',
      'If you are unsure, try a completely different method.',
      'Return corrected JSON.',
    ].join('\n');
  },
  concurrency: 1,
  onRoundComplete(round, report) {
    const exact = (report.scores['exact'] ?? 0) * 100;
    const llm = (report.scores['llm'] ?? 0) * 100;
    console.log(`\nRound ${round + 1}: ${report.passed}/${report.total} passed  exact=${exact.toFixed(0)}%  reasoning=${llm.toFixed(0)}%`);
    for (const c of report.cases) {
      const got = parseAnswer(c.output);
      const exactScore = c.scores.find((s) => s.scorerName === 'exact');
      const llmScore = c.scores.find((s) => s.scorerName === 'llm');
      const status = exactScore?.pass ? '✓' : '✗';
      console.log(
        `  ${status} ${c.case.name}` +
          `  got=${got ?? '?'}  reasoning=${((llmScore?.score ?? 0) * 5).toFixed(1)}/5`,
      );
      if (llmScore?.reason) console.log(`      judge: ${llmScore.reason}`);
    }
  },
})
  .then((report) => {
    console.log('\n--- Final report ---');
    console.log(formatReport(report.final));

    const r0 = report.rounds[0];
    const rf = report.final;
    console.log(
      `Reasoning quality: ${(( r0.scores['llm'] ?? 0) * 100).toFixed(0)}% → ${((rf.scores['llm'] ?? 0) * 100).toFixed(0)}%`,
    );
    console.log(
      `Exact pass rate:   ${report.improvement >= 0 ? '+' : ''}${(report.improvement * 100).toFixed(0)}pp`,
    );
  })
  .catch(console.error);
