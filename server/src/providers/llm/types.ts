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

/**
 * A provider's HTTP refusal, with the status kept so a caller can tell a
 * spent account (429 insufficient_quota) from a rate limit (429) from a bad
 * request. The message is unchanged from before, so nothing that matched on it
 * changes behaviour.
 */
export class LlmApiError extends Error {
  constructor(readonly provider: string, readonly status: number, readonly body: string) {
    super(`${provider} API error ${status}: ${body}`);
    this.name = 'LlmApiError';
  }
  /** The account has no credit left: retrying sooner than an hour only burns goodwill. */
  get insufficientQuota(): boolean {
    return this.status === 429 && /insufficient_quota|credit balance|billing/i.test(this.body);
  }
  get rateLimited(): boolean {
    return this.status === 429 && !this.insufficientQuota;
  }
}

export interface LlmProvider {
  name: string;
  /** true when a real remote model is configured; false for the built-in heuristic path. */
  enabled: boolean;
  generate(messages: LlmMessage[], opts?: LlmGenerateOptions): Promise<LlmResult>;
}
