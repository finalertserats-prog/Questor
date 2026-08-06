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

export interface LlmProvider {
  name: string;
  /** true when a real remote model is configured; false for the built-in heuristic path. */
  enabled: boolean;
  generate(messages: LlmMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<LlmResult>;
}
