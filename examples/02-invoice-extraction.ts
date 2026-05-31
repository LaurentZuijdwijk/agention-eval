/**
 * Invoice extraction example — the primary PDF eval use case.
 *
 * The agent receives raw invoice text and must return a JSON object.
 * Two scorers validate the output:
 *   - jsonSchema  — checks structural correctness
 *   - fieldAccuracy — fuzzy-matches extracted values against ground truth,
 *                     handling currency formatting, whitespace, etc.
 */
import 'dotenv/config'; // load ANTHROPIC_API_KEY etc. from a .env file
import { ClaudeAgent } from '@agentionai/agents/claude';
import { z } from 'zod';
import { EvalDataset, EvalRunner, Scorer, formatReport } from '../src';

const extractor = new ClaudeAgent({
  id: 'extractor',
  name: 'Invoice Extractor',
  description: [
    'Extract invoice fields from the provided document text.',
    'Return a single JSON object with the following fields:',
    '  invoice_no (string), date (string, ISO format), vendor (string), total (number).',
    'Return JSON only — no prose, no markdown.',
  ].join('\n'),
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
});

const invoiceSchema = z.object({
  invoice_no: z.string(),
  date: z.string(),
  vendor: z.string(),
  total: z.number(),
});

const dataset = new EvalDataset([
  {
    name: 'USD invoice with thousands separator',
    input: 'INVOICE\nFrom: Acme Corp\nInvoice #: INV-001\nDate: January 15, 2024\nTotal Due: $1,250.00',
    expected: { invoice_no: 'INV-001', date: '2024-01-15', vendor: 'Acme Corp', total: 1250 },
  },
  {
    name: 'GBP invoice with ISO date',
    input: 'INVOICE\nFrom: Globex Ltd\nInvoice #: INV-002\nDate: 2024-02-01\nAmount: £890.50',
    expected: { invoice_no: 'INV-002', date: '2024-02-01', vendor: 'Globex Ltd', total: 890.50 },
  },
  {
    name: 'EUR invoice, "Ref" label and prose date',
    input: 'INVOICE\nFrom: Initech\nRef: INV-003\nIssued: March 3 2024\nTotal: €2,400.00',
    expected: { invoice_no: 'INV-003', date: '2024-03-03', vendor: 'Initech', total: 2400 },
  },
]);

const runner = new EvalRunner({
  target: extractor,
  dataset,
  scorers: [
    Scorer.jsonSchema(invoiceSchema),
    Scorer.fieldAccuracy(['invoice_no', 'vendor', 'total'], { tolerance: 0.01 }),
  ],
  // Per-case token counts are read from the agent's own usage after each
  // execute(). Keep concurrency at 1 so those counts stay attributed to the
  // right case — a shared agent instance overwrites its usage on every call.
  concurrency: 1,
  onCaseComplete(result, index) {
    const status = result.pass ? '✓' : '✗';
    console.log(`  [${index + 1}] ${status}  tokens: ${result.tokens?.total ?? '—'}`);
  },
});

runner.run().then(formatReport).then(console.log).catch(console.error);
