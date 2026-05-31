import { ZodSchema } from 'zod';
import { IScorer, ScorerContext, ScorerResult, EvalTarget } from './types';

// A tool the target is expected to call: just a name, or a name plus a subset
// of input arguments to assert (only the listed keys are compared).
export type ExpectedToolCall = string | { name: string; input?: Record<string, unknown> };

// --- Value normalisation (used by exactMatch and fieldAccuracy) ---

const CURRENCY_SYMBOLS = /[$£€¥₹₩₪₺₽฿]/g;
const THOUSANDS_SEP_RE = /,(?=\d{3}(\D|$))/g;
// European style: 1.250,00
const EUROPEAN_NUMBER_RE = /^\d{1,3}(\.\d{3})*(,\d+)?$/;

function normalizeValue(val: unknown): number | boolean | string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val;

  if (typeof val === 'string') {
    const trimmed = val.trim();

    // Boolean strings
    const lower = trimmed.toLowerCase();
    if (['yes', 'true', '1', 'on', 'y'].includes(lower)) return true;
    if (['no', 'false', '0', 'off', 'n'].includes(lower)) return false;

    // Strip currency symbols and leading/trailing whitespace
    let cleaned = trimmed.replace(CURRENCY_SYMBOLS, '').trim();

    // Strip trailing % — keep the number as-is (caller decides meaning)
    const isPercent = cleaned.endsWith('%');
    if (isPercent) cleaned = cleaned.slice(0, -1).trim();

    // European number format: 1.250,00 → 1250.00
    if (EUROPEAN_NUMBER_RE.test(cleaned)) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // Anglo format: 1,250.00 → 1250.00
      cleaned = cleaned.replace(THOUSANDS_SEP_RE, '');
    }

    const num = parseFloat(cleaned);
    if (!isNaN(num) && cleaned.length > 0) return num;

    return trimmed;
  }

  return String(val);
}

function valuesEqual(
  actual: unknown,
  expected: unknown,
  tolerance = 0
): boolean {
  const a = normalizeValue(actual);
  const e = normalizeValue(expected);

  if (a === null || e === null) return a === e;

  if (typeof a === 'number' && typeof e === 'number') {
    if (tolerance > 0) {
      return Math.abs(a - e) / Math.max(Math.abs(e), 1) <= tolerance;
    }
    return a === e;
  }

  // Boolean vs boolean
  if (typeof a === 'boolean' && typeof e === 'boolean') return a === e;

  // Coerce boolean against number (e.g. expected=true, actual=1)
  if (typeof a === 'boolean' && typeof e === 'number') return (a ? 1 : 0) === e;
  if (typeof a === 'number' && typeof e === 'boolean') return a === (e ? 1 : 0);

  // String comparison (case-insensitive)
  return String(a).toLowerCase() === String(e).toLowerCase();
}

// Partial deep comparison used to match tool-call arguments. Only keys present
// in `expected` are checked, so you can assert just the important arguments.
// Scalars go through valuesEqual, so the usual leniency applies (e.g. "5" === 5,
// "Paris" === "paris").
function deepValueEqual(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => deepValueEqual(e, actual[i]));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
      deepValueEqual(v, (actual as Record<string, unknown>)[k])
    );
  }
  return valuesEqual(actual, expected);
}

function tryParseJson(output: string): unknown {
  // Strip markdown code fences if present
  const stripped = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

// --- Scorer factory ---

export class Scorer {
  static contains(
    keywords: string[],
    options: { caseSensitive?: boolean } = {}
  ): IScorer {
    const { caseSensitive = false } = options;
    return {
      name: 'contains',
      async score(output): Promise<ScorerResult> {
        const haystack = caseSensitive ? output : output.toLowerCase();
        const missing = keywords.filter((kw) => {
          const needle = caseSensitive ? kw : kw.toLowerCase();
          return !haystack.includes(needle);
        });
        const pass = missing.length === 0;
        return {
          pass,
          score: (keywords.length - missing.length) / Math.max(keywords.length, 1),
          reason: pass ? undefined : `Missing keywords: ${missing.join(', ')}`,
          scorerName: 'contains',
        };
      },
    };
  }

  static exactMatch(fields?: string[]): IScorer {
    return {
      name: 'exactMatch',
      async score(output, expected): Promise<ScorerResult> {
        const parsed = tryParseJson(output);
        if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
          return { pass: false, score: 0, reason: 'Output is not valid JSON', scorerName: 'exactMatch' };
        }
        if (typeof expected !== 'object' || expected === null) {
          return { pass: false, score: 0, reason: 'Expected is not an object', scorerName: 'exactMatch' };
        }

        const keys = fields ?? Object.keys(expected as object);
        const mismatches: string[] = [];

        for (const key of keys) {
          const actualVal = (parsed as Record<string, unknown>)[key];
          const expectedVal = (expected as Record<string, unknown>)[key];
          if (!valuesEqual(actualVal, expectedVal)) {
            mismatches.push(
              `${key}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`
            );
          }
        }

        const pass = mismatches.length === 0;
        return {
          pass,
          score: (keys.length - mismatches.length) / Math.max(keys.length, 1),
          reason: pass ? undefined : mismatches.join('; '),
          scorerName: 'exactMatch',
        };
      },
    };
  }

  static jsonSchema(schema: ZodSchema | object): IScorer {
    const isZod = typeof (schema as ZodSchema).safeParse === 'function';
    return {
      name: 'jsonSchema',
      async score(output): Promise<ScorerResult> {
        const parsed = tryParseJson(output);
        if (parsed === undefined) {
          return { pass: false, score: 0, reason: 'Output is not valid JSON', scorerName: 'jsonSchema' };
        }

        if (isZod) {
          const result = (schema as ZodSchema).safeParse(parsed);
          if (result.success) {
            return { pass: true, score: 1, scorerName: 'jsonSchema' };
          }
          const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          return { pass: false, score: 0, reason: issues, scorerName: 'jsonSchema' };
        }

        // Basic JSON Schema validation for plain objects
        const jsonSchema = schema as Record<string, unknown>;
        const errors = validateJsonSchema(parsed, jsonSchema);
        const pass = errors.length === 0;
        return {
          pass,
          score: pass ? 1 : 0,
          reason: pass ? undefined : errors.join('; '),
          scorerName: 'jsonSchema',
        };
      },
    };
  }

  static llm(
    judgeAgent: EvalTarget,
    options: { criteria: string; scale?: number; passingScore?: number }
  ): IScorer {
    const { criteria, scale = 5, passingScore = 0.6 } = options;
    return {
      name: 'llm',
      async score(output, expected, input): Promise<ScorerResult> {
        const prompt = [
          `You are an evaluation judge. Score the following AI output on a scale of 1 to ${scale}.`,
          ``,
          `Criteria: ${criteria}`,
          ``,
          `Input: ${JSON.stringify(input)}`,
          `Expected: ${JSON.stringify(expected)}`,
          `Output: ${output}`,
          ``,
          `Respond with JSON only, no other text:`,
          `{"score": <integer 1-${scale}>, "reason": "<brief explanation>"}`,
        ].join('\n');

        let raw: string;
        try {
          const result = await judgeAgent.execute(prompt as never);
          raw = typeof result === 'string' ? result : result.toString();
        } catch (err) {
          return {
            pass: false,
            score: 0,
            reason: `Judge agent error: ${err instanceof Error ? err.message : String(err)}`,
            scorerName: 'llm',
          };
        }

        const parsed = tryParseJson(raw);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          typeof (parsed as Record<string, unknown>).score !== 'number'
        ) {
          return { pass: false, score: 0, reason: `Could not parse judge response: ${raw}`, scorerName: 'llm' };
        }

        const rawScore = (parsed as Record<string, unknown>).score as number;
        const normalised = (rawScore - 1) / (scale - 1);
        const clamped = Math.max(0, Math.min(1, normalised));
        const reason = (parsed as Record<string, unknown>).reason as string | undefined;

        return {
          pass: clamped >= passingScore,
          score: clamped,
          reason,
          scorerName: 'llm',
        };
      },
    };
  }

  static fieldAccuracy(
    fields: string[],
    options: { tolerance?: number } = {}
  ): IScorer {
    const { tolerance = 0 } = options;
    return {
      name: 'fieldAccuracy',
      async score(output, expected): Promise<ScorerResult> {
        const parsed = tryParseJson(output);
        if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
          return { pass: false, score: 0, reason: 'Output is not valid JSON', scorerName: 'fieldAccuracy' };
        }
        if (typeof expected !== 'object' || expected === null) {
          return { pass: false, score: 0, reason: 'Expected is not an object', scorerName: 'fieldAccuracy' };
        }

        const mismatches: string[] = [];
        for (const field of fields) {
          const actualVal = (parsed as Record<string, unknown>)[field];
          const expectedVal = (expected as Record<string, unknown>)[field];
          if (!valuesEqual(actualVal, expectedVal, tolerance)) {
            const normActual = normalizeValue(actualVal);
            const normExpected = normalizeValue(expectedVal);
            mismatches.push(
              `${field}: expected ${JSON.stringify(normExpected)}, got ${JSON.stringify(normActual)}`
            );
          }
        }

        const pass = mismatches.length === 0;
        return {
          pass,
          score: (fields.length - mismatches.length) / Math.max(fields.length, 1),
          reason: pass ? undefined : mismatches.join('; '),
          scorerName: 'fieldAccuracy',
        };
      },
    };
  }

  // Scores the tools the target called during the case (read from its history
  // by the runner). `expected` is the tools you expect, each as a name or
  // `{ name, input }` where `input` asserts a subset of the call's arguments.
  //
  // Options:
  //   ordered    — expected calls must appear in this order (as a subsequence).
  //                Default false: order-independent set match.
  //   allowExtra — permit tool calls beyond those expected. Default true:
  //                set false to also fail on unexpected calls.
  static toolCalls(
    expected: ExpectedToolCall[],
    options: { ordered?: boolean; allowExtra?: boolean } = {}
  ): IScorer {
    const { ordered = false, allowExtra = true } = options;
    const wanted = expected.map((e) => (typeof e === 'string' ? { name: e } : e));
    const describe = (e: { name: string; input?: Record<string, unknown> }) =>
      e.input ? `${e.name}(${JSON.stringify(e.input)})` : e.name;
    const matches = (
      e: { name: string; input?: Record<string, unknown> },
      a: { name: string; input: Record<string, unknown> }
    ) => e.name === a.name && (e.input === undefined || deepValueEqual(e.input, a.input));

    return {
      name: 'toolCalls',
      async score(_output, _expected, _input, context?: ScorerContext): Promise<ScorerResult> {
        const actual = context?.toolCalls ?? [];
        const used = new Set<number>();
        const missing: string[] = [];
        let matched = 0;
        let cursor = 0; // for ordered subsequence matching

        for (const want of wanted) {
          let found = -1;
          for (let i = ordered ? cursor : 0; i < actual.length; i++) {
            if (!used.has(i) && matches(want, actual[i])) {
              found = i;
              break;
            }
          }
          if (found >= 0) {
            matched++;
            used.add(found);
            if (ordered) cursor = found + 1;
          } else {
            missing.push(describe(want));
          }
        }

        const extra = allowExtra
          ? []
          : actual.filter((_, i) => !used.has(i)).map((c) => c.name);

        const reasons: string[] = [];
        if (missing.length) reasons.push(`missing: ${missing.join(', ')}`);
        if (extra.length) reasons.push(`unexpected: ${extra.join(', ')}`);

        const pass = missing.length === 0 && extra.length === 0;
        return {
          pass,
          score: wanted.length > 0 ? matched / wanted.length : extra.length === 0 ? 1 : 0,
          reason: pass ? undefined : reasons.join('; ') || 'tool calls did not match',
          scorerName: 'toolCalls',
        };
      },
    };
  }

  static custom(
    name: string,
    fn: (
      output: string,
      expected: unknown,
      input: unknown,
      context?: ScorerContext
    ) => Promise<ScorerResult>
  ): IScorer {
    return {
      name,
      async score(output, expected, input, context): Promise<ScorerResult> {
        const result = await fn(output, expected, input, context);
        return { ...result, scorerName: name };
      },
    };
  }
}

// Minimal JSON Schema validator (covers type, required, properties)
function validateJsonSchema(
  data: unknown,
  schema: Record<string, unknown>,
  path = ''
): string[] {
  const errors: string[] = [];

  if (schema.type) {
    const expectedType = schema.type as string;
    const actualType = Array.isArray(data) ? 'array' : typeof data;
    if (actualType !== expectedType) {
      errors.push(`${path || 'root'}: expected type ${expectedType}, got ${actualType}`);
      return errors;
    }
  }

  if (schema.required && Array.isArray(schema.required) && typeof data === 'object' && data !== null) {
    for (const key of schema.required as string[]) {
      if (!(key in (data as object))) {
        errors.push(`${path ? `${path}.` : ''}${key}: required field missing`);
      }
    }
  }

  if (schema.properties && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in (data as object)) {
        const childPath = path ? `${path}.${key}` : key;
        errors.push(...validateJsonSchema((data as Record<string, unknown>)[key], subSchema, childPath));
      }
    }
  }

  return errors;
}
