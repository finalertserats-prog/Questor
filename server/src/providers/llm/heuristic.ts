import type { LlmProvider, LlmMessage, LlmResult } from './types.js';

/**
 * The built-in, no-key provider. It is intentionally `enabled = false`: engines
 * detect this and use their deterministic heuristic implementations instead of
 * calling a remote model. This keeps the whole product fully functional with
 * zero paid licenses. `generate` is only reached if an engine ignores the flag,
 * in which case it echoes a safe empty completion.
 */
export class HeuristicLlmProvider implements LlmProvider {
  name = 'heuristic';
  enabled = false;

  async generate(_messages: LlmMessage[]): Promise<LlmResult> {
    return { text: '', model: 'heuristic', inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  }
}
