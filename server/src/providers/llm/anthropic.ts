import type { LlmProvider, LlmMessage, LlmResult } from './types.js';

/** Anthropic Messages API connector. Plug in ANTHROPIC_API_KEY to enable. */
export class AnthropicLlmProvider implements LlmProvider {
  name = 'anthropic';
  enabled = true;
  constructor(private apiKey: string, private model: string) {}

  async generate(messages: LlmMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<LlmResult> {
    const started = Date.now();
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const convo = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        system: system || undefined,
        messages: convo,
        max_tokens: opts?.maxTokens ?? 1500,
        temperature: opts?.temperature ?? 0.4,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const text = (data.content ?? []).map((c: any) => c.text ?? '').join('');
    return {
      text,
      model: this.model,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
