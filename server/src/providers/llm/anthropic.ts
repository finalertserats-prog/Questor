import { LlmApiError, type LlmGenerateOptions, type LlmMessage, type LlmProvider, type LlmResult } from './types.js';

/** The reply budget when a caller does not set one. */
const DEFAULT_MAX_TOKENS = 1500;

interface MessagesResponse {
  content?: Array<{ type?: unknown; text?: unknown }>;
  stop_reason?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The Messages API request body for this model. Pure, so the shape is tested without a network. */
export function anthropicRequestBody(model: string, messages: LlmMessage[], opts: LlmGenerateOptions | undefined): Record<string, unknown> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  return {
    model,
    ...(system ? { system } : {}),
    messages: convo,
    max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts?.temperature ?? 0.4,
  };
}

/** Anthropic Messages API connector. Plug in ANTHROPIC_API_KEY to enable. */
export class AnthropicLlmProvider implements LlmProvider {
  name = 'anthropic';
  enabled = true;
  constructor(private apiKey: string, private model: string) {}

  async generate(messages: LlmMessage[], opts?: LlmGenerateOptions): Promise<LlmResult> {
    const started = Date.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicRequestBody(this.model, messages, opts)),
    });
    if (!res.ok) throw new LlmApiError('Anthropic', res.status, await res.text());
    const data = (await res.json()) as MessagesResponse;
    const text = (data.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
    // Same rule as the OpenAI adapter: a cut-off reply is a failure, not a
    // shorter answer, because callers parse it as JSON or speak it aloud.
    if (data.stop_reason === 'max_tokens') throw new Error('Anthropic reply truncated (stop_reason max_tokens)');
    if (!text.trim()) throw new Error('Anthropic returned an empty reply');
    return {
      text,
      model: this.model,
      inputTokens: count(data.usage?.input_tokens),
      outputTokens: count(data.usage?.output_tokens),
      latencyMs: Date.now() - started,
    };
  }
}
