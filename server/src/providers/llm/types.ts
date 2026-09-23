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

/**
 * The last line of defence on a hung socket: what an adapter uses when a
 * caller passed no options at all. Every path through `generateJson` supplies
 * a purpose budget well under this, so reaching it means someone called an
 * adapter directly — which must still end, and must not end at undici's 300 s
 * default (docs/qa/resilience-2026-09-23.md, R1).
 */
export const PROVIDER_HARD_TIMEOUT_MS = 120_000;

export interface LlmGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  /**
   * Bounds the call. Required: a model call with no ceiling is how a candidate
   * waits 212 s for a turn that never comes. Adapters fall back to
   * `PROVIDER_HARD_TIMEOUT_MS` only when no options object is passed at all.
   */
  timeoutMs: number;
  /** Per-call override of the configured effort, e.g. more for grading than for a spoken turn. */
  reasoningEffort?: ReasoningEffort;
  /**
   * The caller will parse the reply as JSON. Only the local adapter acts on it
   * (Ollama's constrained JSON output, which keeps a small model on shape);
   * the hosted adapters ignore it, so their requests are unchanged.
   */
  responseFormat?: 'json';
  /**
   * Abandon the call if the first token has not arrived by then. Only a
   * streaming adapter (the local one) can tell; the others ignore it.
   */
  firstTokenMs?: number;
}

/** A streamed reply that stopped before it was finished: the connection or the model runner died. */
export class LlmStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmStreamError';
  }
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
