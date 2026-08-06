import type { LlmProvider, LlmMessage, LlmResult } from './types.js';

/** OpenAI Chat Completions connector. Plug in OPENAI_API_KEY to enable. */
export class OpenAiLlmProvider implements LlmProvider {
  name = 'openai';
  enabled = true;
  constructor(private apiKey: string, private model: string) {}

  async generate(messages: LlmMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<LlmResult> {
    const started = Date.now();
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts?.maxTokens ?? 1500,
        temperature: opts?.temperature ?? 0.4,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      model: this.model,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
