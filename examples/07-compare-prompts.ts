/**
 * Prompt comparison — evaluating different system prompts on the same model.
 *
 * EvalRunner.compare() treats each target independently, so you can use it
 * to A/B test prompt variants just as easily as model variants. Each target
 * is the same model with a different description (system prompt).
 *
 * The judge evaluates all variants consistently, giving you a data-driven
 * answer to "which phrasing produces the most faithful summaries?"
 *
 * This is a common workflow before shipping a prompt to production:
 *   1. Draft several candidate prompts
 *   2. Run this comparison on a representative dataset
 *   3. Pick the variant with the highest judge score
 *   4. Lock that prompt into a single-target EvalRunner with failIf to gate CI
 *      (EvalRunner.compare itself never gates — it always returns every report)
 */
import { ClaudeAgent } from '@agentionai/agents/claude';
import { EvalDataset, EvalRunner, Scorer, formatReport } from '../src';

const API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = 'claude-haiku-4-5-20251001' as const;

const judge = new ClaudeAgent({
  id: 'judge',
  name: 'Faithfulness Judge',
  description: 'You are a precise evaluation judge. Return only JSON.',
  apiKey: API_KEY,
  model: MODEL,
  temperature: 0,
});

const dataset = new EvalDataset([
  {
    input: `The James Webb Space Telescope (JWST) launched on 25 December 2021. It is the
largest optical telescope in space and observes in the infrared spectrum.
Its primary mirror is 6.5 metres in diameter, giving it a much larger
light-collecting area than its predecessor, the Hubble Space Telescope.`,
    expected: 'Should mention: JWST launched December 2021, observes in infrared, 6.5m primary mirror.',
    metadata: { topic: 'astronomy' },
  },
  {
    input: `Python was created by Guido van Rossum and first released in 1991. It emphasises
code readability and uses significant indentation. Python supports multiple
programming paradigms including procedural, object-oriented, and functional.`,
    expected: 'Should mention: creator Guido van Rossum, 1991 release, readability emphasis.',
    metadata: { topic: 'technology' },
  },
  {
    input: `The Mediterranean diet is based on the traditional foods of countries bordering
the Mediterranean Sea. It is rich in fruits, vegetables, whole grains, legumes,
nuts, and olive oil. Studies associate it with reduced risk of heart disease.`,
    expected: 'Should mention: Mediterranean origin, key food groups (olive oil, vegetables), heart disease benefit.',
    metadata: { topic: 'health' },
  },
]);

const scorers = [
  Scorer.llm(judge, {
    criteria: 'Does the summary faithfully cover the key points described in the Expected field? Penalise omissions and hallucinations.',
    scale: 5,
    passingScore: 0.6,
  }),
];

const makeAgent = (id: string, description: string) =>
  new ClaudeAgent({ id, name: id, description, apiKey: API_KEY, model: MODEL, temperature: 0.3 });

EvalRunner.compare(dataset, scorers, {
  // Baseline: minimal prompt — common starting point, often underspecified
  'minimal': makeAgent('minimal',
    'Summarise the text.',
  ),

  // Explicit constraints: tells the model exactly what to do and not do
  'explicit': makeAgent('explicit',
    'Summarise the provided text in 1–2 sentences. Be concise and faithful to the source — do not add information that is not present.',
  ),

  // Output framing: specifies the reader context, which often sharpens focus
  'framed': makeAgent('framed',
    'You are writing a one-sentence abstract for a knowledge base. Capture the most important facts from the text without interpretation or addition.',
  ),

  // Chain-of-thought hint: asking the model to reason before summarising
  // can improve coverage of key points at the cost of some verbosity
  'chain-of-thought': makeAgent('chain-of-thought',
    'First identify the 2–3 most important facts in the text. Then write a 1–2 sentence summary that covers all of them faithfully.',
  ),
})
  .then((reports) => {
    for (const [variant, report] of Object.entries(reports)) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`  ${variant}`);
      console.log('─'.repeat(50));
      console.log(formatReport(report));
    }

    // Print a ranked summary for easy comparison
    const ranked = Object.entries(reports)
      .map(([name, r]) => ({ name, score: r.scores['llm'] ?? 0, passRate: r.passRate }))
      .sort((a, b) => b.score - a.score);

    console.log('\n=== Prompt Ranking (by mean judge score) ===');
    ranked.forEach(({ name, score, passRate }, i) => {
      console.log(`  ${i + 1}. ${name.padEnd(20)} score: ${score.toFixed(3)}  pass rate: ${(passRate * 100).toFixed(1)}%`);
    });
    console.log('');
  })
  .catch(console.error);
