export interface EvalCase<TInput = string> {
  input: TInput;
  expected?: unknown;
  metadata?: Record<string, unknown>;
  // Human-readable label for what this case verifies. Used as the test
  // description in reports (TAP and human-readable); falls back to a preview
  // of the input when omitted.
  name?: string;
}

export interface ScorerResult {
  pass: boolean;
  score: number;
  reason?: string;
  scorerName: string;
}

// A single tool/function call made by the target during a case, extracted from
// the agent's history. `id` is the provider's tool-call id when available.
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

// Extra per-case signals handed to scorers alongside the string output, so a
// scorer can assert on behaviour the output text doesn't capture (e.g. which
// tools were called). Optional — existing scorers that ignore it still work.
export interface ScorerContext {
  toolCalls: ToolCall[];
}

export interface EvalCaseResult<TInput = string> {
  case: EvalCase<TInput>;
  output: string;
  scores: ScorerResult[];
  pass: boolean;
  durationMs: number;
  tokens?: { input: number; output: number; total: number };
  toolCalls?: ToolCall[];
}

export interface EvalReport<TInput = string> {
  passed: number;
  failed: number;
  total: number;
  passRate: number;
  scores: Record<string, number>;
  tokenCost: { total: number; perCase: number };
  durationMs: number;
  cases: EvalCaseResult<TInput>[];
}

export interface IScorer<TInput = string> {
  name: string;
  score(
    output: string,
    expected: unknown,
    input: TInput,
    context?: ScorerContext
  ): Promise<ScorerResult>;
}

// Structural interface — satisfied by any Agention Pipeline, AgentGraph, or GraphNode
export interface EvalTarget<TInput = string> {
  execute(input: TInput): Promise<string | { toString(): string }>;
}

export interface EvalThreshold {
  lt?: number;   // fail if value is less than this
  lte?: number;  // fail if value is less than or equal to this
}

export interface EvalFailConditions {
  passRate?: EvalThreshold;
  scores?: Record<string, EvalThreshold>;
}
