import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiLlmProvider, isReasoningModel, openAiRequestBody } from '../src/providers/llm/openai.js';
import { parseReasoningEffortSetting } from '../src/config.js';

// The owner moved production to gpt-5.6-sol. Verified live: that model refuses
// `max_tokens` with a 400 ("Use 'max_completion_tokens' instead") and ignores
// temperature, while gpt-4o still wants both. Every interviewer turn would have
// failed over to the heuristic bank without anyone noticing.

const messages = [{ role: 'user' as const, content: 'x' }];

describe('isReasoningModel', () => {
  it.each([
    ['gpt-5.6-sol', true], ['gpt-5', true], ['gpt-5-mini', true], ['GPT-5.1', true],
    ['o1', true], ['o1-mini', true], ['o3', true], ['o3-mini', true], ['o4-mini', true],
    ['gpt-4o', false], ['gpt-4o-mini', false], ['gpt-4.1', false], ['gpt-4-turbo', false], ['gpt-3.5-turbo', false],
  ])('%s -> %s', (model, expected) => {
    expect(isReasoningModel(model)).toBe(expected);
  });
});

describe('openAiRequestBody', () => {
  it('sends max_completion_tokens and a reasoning effort to a reasoning model, and no temperature', () => {
    const body = openAiRequestBody('gpt-5.6-sol', messages, { maxTokens: 400, temperature: 0.6 }, 'low');
    expect(body).toMatchObject({ model: 'gpt-5.6-sol', reasoning_effort: 'low' });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('budgets for reasoning tokens on top of the reply, so the reply is not truncated to nothing', () => {
    const body = openAiRequestBody('o3-mini', messages, { maxTokens: 400 }, 'low');
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(400 + 1000);
  });

  it('lets a call ask for more reasoning than the default', () => {
    const body = openAiRequestBody('gpt-5.6-sol', messages, { reasoningEffort: 'medium' }, 'low');
    expect(body.reasoning_effort).toBe('medium');
  });

  it('keeps max_tokens and temperature for an older chat model', () => {
    const body = openAiRequestBody('gpt-4o', messages, { maxTokens: 400, temperature: 0.6 }, 'low');
    expect(body).toMatchObject({ model: 'gpt-4o', max_tokens: 400, temperature: 0.6 });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});

describe('OpenAiLlmProvider reply handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  function reply(body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
  }

  it('treats an empty reply as a failure, not as an empty question', async () => {
    reply({ choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: {} });
    await expect(new OpenAiLlmProvider('k', 'gpt-5.6-sol').generate(messages)).rejects.toThrow(/empty/i);
  });

  it('treats a reply cut off by the token budget as a failure', async () => {
    reply({ choices: [{ message: { content: '{"question": "Tell me ab' }, finish_reason: 'length' }], usage: {} });
    await expect(new OpenAiLlmProvider('k', 'gpt-5.6-sol').generate(messages)).rejects.toThrow(/length|truncated/i);
  });

  it('returns a complete reply', async () => {
    reply({ choices: [{ message: { content: '{"question":"Why?"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } });
    const res = await new OpenAiLlmProvider('k', 'gpt-5.6-sol').generate(messages);
    expect(res.text).toBe('{"question":"Why?"}');
  });
});

describe('OPENAI_REASONING_EFFORT', () => {
  it.each(['none', 'minimal', 'low', 'medium', 'high'])('accepts %s', (v) => {
    expect(parseReasoningEffortSetting(v)).toBe(v);
  });

  it('defaults to low, because an interviewer turn is spoken and latency is felt', () => {
    expect(parseReasoningEffortSetting(undefined)).toBe('low');
    expect(parseReasoningEffortSetting('')).toBe('low');
  });

  it('refuses anything else at boot', () => {
    expect(() => parseReasoningEffortSetting('fast')).toThrow(/OPENAI_REASONING_EFFORT/);
  });
});
