/**
 * Model comparison example.
 *
 * Runs the same dataset against multiple models side-by-side using
 * EvalRunner.compare(). Useful for deciding which model is cost-effective
 * for a given extraction task.
 */
import { ClaudeAgent } from "@agentionai/agents/claude";
import { z } from "zod";
import { EvalDataset, EvalRunner, Scorer, formatReport } from "../src";

const DESCRIPTION = [
  "Extract the product name and price from the text.",
  'Return JSON only: {"product": string, "price": number}',
].join("\n");

const API_KEY = process.env.ANTHROPIC_API_KEY!;

const schema = z.object({
  product: z.string(),
  price: z.number(),
});

const dataset = new EvalDataset([
  {
    input: 'MacBook Pro 14" — $1,999.00',
    expected: { product: 'MacBook Pro 14"', price: 1999 },
  },
  {
    input: "Sony WH-1000XM5 headphones — £279.99",
    expected: { product: "Sony WH-1000XM5 headphones", price: 279.99 },
  },
  {
    input: "Kindle Paperwhite (16 GB) — €139,99",
    expected: { product: "Kindle Paperwhite (16 GB)", price: 139.99 },
  },
]);

const scorers = [
  Scorer.jsonSchema(schema),
  Scorer.fieldAccuracy(["price"], { tolerance: 0.01 }),
];

EvalRunner.compare(dataset, scorers, {
  "claude-haiku-4-5": new ClaudeAgent({
    id: "haiku",
    name: "Haiku Extractor",
    description: DESCRIPTION,
    apiKey: API_KEY,
    model: "claude-haiku-4-5-20251001",
  }),
  "claude-sonnet-4-6": new ClaudeAgent({
    id: "sonnet",
    name: "Sonnet Extractor",
    description: DESCRIPTION,
    apiKey: API_KEY,
    model: "claude-sonnet-4-6",
  }),
})
  .then((reports) => {
    for (const [model, report] of Object.entries(reports)) {
      console.log(`\n--- ${model} ---`);
      console.log(formatReport(report));
    }
  })
  .catch(console.error);
