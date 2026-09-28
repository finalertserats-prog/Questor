import { describe, expect, it } from 'vitest';
import { classifyLlmFailure, cooldownKindFor, shouldFailOver } from '../src/providers/llm/failures.js';
import { LlmApiError, LlmStreamError } from '../src/providers/llm/types.js';

/**
 * Only failures another provider can fix move a request down the chain. A
 * reply the model got wrong, or a request we built wrong, would fail the same
 * way locally, so those go straight to the built-in writer as they do today.
 */

const api = (status: number, body = '{}') => new LlmApiError('OpenAI', status, body);

describe('classifyLlmFailure', () => {
  it.each([
    ['a 401', api(401, '{"error":{"code":"invalid_api_key"}}'), 'auth'],
    ['a 403', api(403), 'auth'],
    ['a spent account', api(429, '{"error":{"code":"insufficient_quota"}}'), 'quota'],
    ['a rate limit', api(429, '{"error":{"code":"rate_limit_exceeded"}}'), 'rate_limit'],
    ['a 500', api(500), 'server'],
    ['a 503', api(503), 'server'],
    ['a 400', api(400, 'Unsupported parameter'), 'bad_request'],
    ['a 404', api(404), 'bad_request'],
    ['a provider abort', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'timeout'],
    ['an AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'],
    ['our own deadline', new Error('model call exceeded 12000ms'), 'timeout'],
    ['a refused connection', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'network'],
    ['a stream cut off mid-reply', new LlmStreamError('Ollama stream ended before the reply was done'), 'interrupted'],
    ['a truncated reply', new Error('OpenAI reply truncated (finish_reason length)'), 'bad_reply'],
    ['an unparseable reply', new Error('no JSON value found in model reply'), 'bad_reply'],
  ])('classifies %s', (_label, err, expected) => {
    expect(classifyLlmFailure(err)).toBe(expected);
  });
});

describe('shouldFailOver', () => {
  it.each(['auth', 'quota', 'rate_limit', 'server', 'timeout', 'network', 'interrupted', 'slow'] as const)('moves %s down the chain', (cls) => {
    expect(shouldFailOver(cls)).toBe(true);
  });

  it.each(['bad_request', 'bad_reply'] as const)('does not move %s down the chain', (cls) => {
    expect(shouldFailOver(cls)).toBe(false);
  });
});

describe('cooldownKindFor', () => {
  it.each(['auth', 'quota'] as const)('rests the provider for the long cooldown after %s', (cls) => {
    expect(cooldownKindFor(cls)).toBe('long');
  });

  it.each(['rate_limit', 'server', 'timeout', 'network', 'interrupted', 'slow'] as const)('rests the provider briefly after %s', (cls) => {
    expect(cooldownKindFor(cls)).toBe('short');
  });

  it.each(['bad_request', 'bad_reply'] as const)('does not rest the provider after %s', (cls) => {
    expect(cooldownKindFor(cls)).toBe('none');
  });
});
