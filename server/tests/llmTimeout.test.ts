import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiLlmProvider } from '../src/providers/llm/openai.js';
import { AnthropicLlmProvider } from '../src/providers/llm/anthropic.js';

/**
 * A model call made from a background job must end. The catalog refresh asks
 * for a timeout; every other caller keeps the behaviour it had (none).
 */

function captureFetch(body: unknown) {
  const inits: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { inits.push(init); return new Response(JSON.stringify(body)); }));
  return inits;
}

const openAiReply = { choices: [{ message: { content: '[]' } }], usage: {} };
const anthropicReply = { content: [{ type: 'text', text: '[]' }], usage: {} };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model call timeouts', () => {
  it('bounds an OpenAI call when the caller asks for a timeout', async () => {
    const inits = captureFetch(openAiReply);
    await new OpenAiLlmProvider('k', 'm').generate([{ role: 'user', content: 'x' }], { timeoutMs: 60_000 });
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('leaves an OpenAI call unbounded for callers that did not ask', async () => {
    const inits = captureFetch(openAiReply);
    await new OpenAiLlmProvider('k', 'm').generate([{ role: 'user', content: 'x' }]);
    expect(inits[0].signal).toBeUndefined();
  });

  it('bounds an Anthropic call when the caller asks for a timeout', async () => {
    const inits = captureFetch(anthropicReply);
    await new AnthropicLlmProvider('k', 'm').generate([{ role: 'user', content: 'x' }], { timeoutMs: 60_000 });
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });
});
