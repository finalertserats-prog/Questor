export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** How hard a reasoning model thinks before replying. Ignored by models that do not reason. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface LlmGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  /** Bounds the call; unset keeps the provider's default (no timeout). */
  timeoutMs?: number;
  /** Per-call override of the configured effort, e.g. more for grading than for a spoken turn. */
  reasoningEffort?: ReasoningEffort;
}

export interface LlmProvider {
  name: string;
  /** true when a real remote model is configured; false for the built-in heuristic path. */
  enabled: boolean;
  generate(messages: LlmMessage[], opts?: LlmGenerateOptions): Promise<LlmResult>;
}
