import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmApiError, type LlmMessage, type LlmProvider, type LlmResult } from '../src/providers/llm/types.js';

/**
 * LOCAL_LLM_ENABLED defaults to off, and off must mean exactly today's chain:
 * the configured provider, then the built-in writer. No local call, no
 * cooldown memory, no email.
 */

const sent: unknown[] = [];
vi.mock('../src/providers/email/index.js', () => ({
  getEmail: () => ({ name: 'fake', configured: true, delivers: true, send: async (m: unknown) => { sent.push(m); return { status: 'sent', id: 'x' }; } }),
}));

const { config } = await import('../src/config.js');
const { generateJson, _setLlmForTests, llmServingStatus } = await import('../src/providers/llm/index.js');

class FailingProvider implements LlmProvider {
  name = 'openai';
  enabled = true;
  calls = 0;
  async generate(_m: LlmMessage[]): Promise<LlmResult> {
    this.calls++;
    throw new LlmApiError('OpenAI', 429, '{"error":{"code":"insufficient_quota"}}');
  }
}

let primary: FailingProvider;
const fetchSpy = vi.fn(async () => new Response('{}'));

beforeEach(() => {
  primary = new FailingProvider();
  _setLlmForTests(primary);
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  sent.length = 0;
});

afterEach(() => {
  _setLlmForTests(null);
  vi.unstubAllGlobals();
});

const ask = () => generateJson<unknown>({ fn: 'live_interviewer', purpose: 'live_turn', system: 's', user: 'u', timeoutMs: 12_000, validate: (raw) => raw });

describe('LOCAL_LLM_ENABLED off (the default)', () => {
  it('is off by default', () => {
    expect(config.llm.local.enabled).toBe(false);
  });

  it('falls straight to the built-in writer when the primary fails', async () => {
    expect(await ask()).toBeNull();
  });

  it('makes no network call to a local model', async () => {
    await ask();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps no failure memory: every turn tries the primary again', async () => {
    await ask();
    await ask();
    expect(primary.calls).toBe(2);
  });

  it('sends no alert email', async () => {
    await ask();
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);
  });

  it('passes the call to the primary exactly as before (no JSON format hint)', async () => {
    const seen: unknown[] = [];
    _setLlmForTests({ name: 'openai', enabled: true, generate: async (_m, opts) => { seen.push(opts); return { text: '{}', model: 'm', inputTokens: 0, outputTokens: 0, latencyMs: 0 }; } });
    await ask();
    expect(seen[0]).toEqual({ temperature: 0.3, maxTokens: undefined, timeoutMs: 12_000, reasoningEffort: undefined });
  });

  it('reports the local fallback as off', () => {
    expect(llmServingStatus().local.enabled).toBe(false);
  });

  it('reports the primary layer while it is configured', () => {
    expect(llmServingStatus().layer).toBe('primary');
  });
});
