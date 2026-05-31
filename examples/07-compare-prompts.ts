/**
 * Prompt comparison — finding the best system prompt by head-to-head judging.
 *
 * Each target is the same model with a different description (system prompt).
 *
 * The naive approach — score every variant independently with Scorer.llm and
 * rank by mean score — does NOT work here: pointwise absolute scoring saturates.
 * On a task this easy the judge rates every summary 5/5, so all four prompts
 * tie at 100% and you learn nothing about which is actually better.
 *
 * EvalRunner.rank() fixes this by showing the judge all four outputs for the
 * same input and asking it to rank them against each other. Relative judgments
 * are far more discriminating than absolute ones. Outputs are anonymised and
 * shuffled per case, so the judge can't anchor on a prompt's name or position.
 *
 * Workflow before shipping a prompt to production:
 *   1. Draft several candidate prompts
 *   2. Rank them head-to-head on a representative dataset
 *   3. Pick the variant that wins most often
 *   4. Lock it into a single-target EvalRunner with failIf to gate CI
 */
import "dotenv/config"; // load ANTHROPIC_API_KEY etc. from a .env file
import { ClaudeAgent } from "@agentionai/agents/claude";
import { EvalDataset, EvalRunner } from "../src";

const API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = "claude-haiku-4-5-20251001" as const;

// The judge compares candidates; temperature 0 keeps rankings stable between runs.
const judge = new ClaudeAgent({
  id: "judge",
  name: "Comparison Judge",
  description: "You are a precise evaluation judge. Return only JSON.",
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
    expected:
      "Should mention: JWST launched December 2021, observes in infrared, 6.5m primary mirror.",
    metadata: { topic: "astronomy" },
  },
  {
    input: `Python was created by Guido van Rossum and first released in 1991. It emphasises
code readability and uses significant indentation. Python supports multiple
programming paradigms including procedural, object-oriented, and functional.`,
    expected:
      "Should mention: creator Guido van Rossum, 1991 release, readability emphasis.",
    metadata: { topic: "technology" },
  },
  {
    input: `The Mediterranean diet is based on the traditional foods of countries bordering
the Mediterranean Sea. It is rich in fruits, vegetables, whole grains, legumes,
nuts, and olive oil. Studies associate it with reduced risk of heart disease.`,
    expected:
      "Should mention: Mediterranean origin, key food groups (olive oil, vegetables), heart disease benefit.",
    metadata: { topic: "health" },
  },
]);

const makeAgent = (id: string, description: string) =>
  new ClaudeAgent({
    id,
    name: id,
    description,
    apiKey: API_KEY,
    model: MODEL,
    temperature: 0.3,
  });

EvalRunner.rank({
  dataset,
  judge,
  criteria:
    "Which summary most faithfully and concisely covers the key points in the source — capturing the essentials, without omissions, padding, or added information?",
  targets: {
    // Baseline: minimal prompt — common starting point, often underspecified
    minimal: makeAgent("minimal", "Summarise the text."),

    // Explicit constraints: tells the model exactly what to do and not do
    explicit: makeAgent(
      "explicit",
      "Summarise the provided text in 1–2 sentences. Be concise and faithful to the source — do not add information that is not present.",
    ),

    // Output framing: specifies the reader context, which often sharpens focus
    framed: makeAgent(
      "framed",
      "You are writing a one-sentence abstract for a knowledge base. Capture the most important facts from the text without interpretation or addition.",
    ),

    // Chain-of-thought hint: reason before summarising
    "chain-of-thought": makeAgent(
      "chain-of-thought",
      "First identify the 2–3 most important facts in the text. Then write a 1–2 sentence summary that covers all of them faithfully.",
    ),
  },
})
  .then((report) => {
    // Per-case rankings, so you can see how the judge decided each one.
    for (const c of report.cases) {
      console.log(`\n${"─".repeat(50)}`);
      console.log(
        `  ${c.case.metadata?.topic ?? "case"}: ${c.ranking.join("  >  ") || "(judge failed)"}`,
      );
      if (c.reason) console.log(`  ${c.reason}`);
    }

    // Aggregate leaderboard across all cases.
    console.log(`\n=== Prompt Ranking (head-to-head judge) ===`);
    report.leaderboard.forEach((t, i) => {
      console.log(
        `  ${i + 1}. ${t.name.padEnd(20)} wins: ${t.wins}  points: ${t.points}  avg rank: ${t.averageRank.toFixed(2)}`,
      );
    });
    console.log("");
  })
  .catch(console.error);
