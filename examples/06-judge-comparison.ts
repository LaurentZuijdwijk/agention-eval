/**
 * Multi-provider judge comparison — scoring agents from different providers
 * with the same judge.
 *
 * EvalRunner.compare() accepts any scorers including Scorer.llm(). The same
 * judge instance evaluates every target's output, which keeps scoring
 * consistent across providers — no per-target judge variance.
 *
 * The judge runs at temperature 0 so its own scoring doesn't drift between
 * targets and inflate or deflate comparisons.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... MISTRAL_API_KEY=... \
 *   node --import tsx examples/06-judge-comparison.ts
 */
import { ClaudeAgent, OpenAiAgent, MistralAgent } from '@agentionai/agents';
import { EvalDataset, EvalRunner, Scorer, formatReport } from '../src';

const DESCRIPTION = [
  'Summarise the provided text in 1–2 sentences.',
  'Be concise and faithful to the source — do not add information.',
].join('\n');

// Anthropic is used as the judge provider here because Claude models reliably
// follow the JSON-only instruction. Swap for any provider you trust to do so.
const judge = new ClaudeAgent({
  id: 'judge',
  name: 'Faithfulness Judge',
  description: 'You are a precise evaluation judge. Return only JSON.',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
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

EvalRunner.compare(dataset, scorers, {
  'claude-haiku': new ClaudeAgent({
    id: 'claude-haiku',
    name: 'Claude Haiku',
    description: DESCRIPTION,
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.3,
  }),
  'claude-sonnet': new ClaudeAgent({
    id: 'claude-sonnet',
    name: 'Claude Sonnet',
    description: DESCRIPTION,
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
    temperature: 0.3,
  }),
  'gpt-4o-mini': new OpenAiAgent({
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    description: DESCRIPTION,
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
    temperature: 0.3,
  }),
  'mistral-small': new MistralAgent({
    id: 'mistral-small',
    name: 'Mistral Small',
    description: DESCRIPTION,
    apiKey: process.env.MISTRAL_API_KEY!,
    model: 'mistral-small-latest',
    temperature: 0.3,
  }),
})
  .then((reports) => {
    for (const [target, report] of Object.entries(reports)) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`  ${target}`);
      console.log('─'.repeat(50));
      console.log(formatReport(report, { groupBy: 'topic' }));
    }
  })
  .catch(console.error);
