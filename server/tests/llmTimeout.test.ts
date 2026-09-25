import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiLlmProvider } from '../src/providers/llm/openai.js';
import { AnthropicLlmProvider } from '../src/providers/llm/anthropic.js';

/**
 * Every model call must end. Until 2026-09-23 only callers that asked for a
 * timeout got one, and eight of eleven did not ask — so the adapters now bound
 * the socket themselves whatever the caller passed. See llmCallBudgets.test.ts
 * for the per-call-site budgets.
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

  it('bounds an OpenAI call even when the caller did not ask', async () => {
    const inits = captureFetch(openAiReply);
    await new OpenAiLlmProvider('k', 'm').generate([{ role: 'user', content: 'x' }]);
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds an Anthropic call when the caller asks for a timeout', async () => {
    const inits = captureFetch(anthropicReply);
    await new AnthropicLlmProvider('k', 'm').generate([{ role: 'user', content: 'x' }], { timeoutMs: 60_000 });
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });
});
