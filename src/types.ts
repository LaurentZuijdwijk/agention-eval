export interface EvalCase<TInput = string> {
  input: TInput;
  expected?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ScorerResult {
  pass: boolean;
  score: number;
  reason?: string;
  scorerName: string;
}

export interface EvalCaseResult<TInput = string> {
  case: EvalCase<TInput>;
  output: string;
  scores: ScorerResult[];
  pass: boolean;
  durationMs: number;
  tokens?: { input: number; output: number; total: number };
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
  score(output: string, expected: unknown, input: TInput): Promise<ScorerResult>;
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
