import { describe, expect, it } from 'vitest';
import { fetchWithRetry, SourceFetchError, type SourceHttp } from '../src/services/catalogSources/http.js';

function scripted(responses: readonly (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const http: SourceHttp = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { sleeps.push(ms); },
    timeoutMs: 1_000,
  };
  return { http, calls, sleeps };
}

describe('fetching from an outside source', () => {
  it('returns a successful response', async () => {
    const { http } = scripted([new Response('ok')]);
    expect(await (await fetchWithRetry('https://example.test/a', http)).text()).toBe('ok');
  });

  it('retries a server error and succeeds', async () => {
    const { http, calls } = scripted([new Response('', { status: 503 }), new Response('ok')]);
    await fetchWithRetry('https://example.test/a', http);
    expect(calls).toHaveLength(2);
  });

  it('waits longer before each retry', async () => {
    const { http, sleeps } = scripted([new Response('', { status: 500 }), new Response('', { status: 502 }), new Response('ok')]);
    await fetchWithRetry('https://example.test/a', http);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
  });

  it('retries when the server asks it to slow down', async () => {
    const { http, calls } = scripted([new Response('', { status: 429 }), new Response('ok')]);
    await fetchWithRetry('https://example.test/a', http);
    expect(calls).toHaveLength(2);
  });

  it('retries a network failure', async () => {
    const { http, calls } = scripted([new TypeError('fetch failed'), new Response('ok')]);
    await fetchWithRetry('https://example.test/a', http);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a client error', async () => {
    const { http, calls } = scripted([new Response('', { status: 404 })]);
    await expect(fetchWithRetry('https://example.test/a', http)).rejects.toBeInstanceOf(SourceFetchError);
    expect(calls).toHaveLength(1);
  });

  it('gives up after its attempts and names the host and status', async () => {
    const { http, calls } = scripted([new Response('', { status: 503 })]);
    await expect(fetchWithRetry('https://example.test/a', http, { attempts: 3 })).rejects.toThrow(/example\.test.*503/);
    expect(calls).toHaveLength(3);
  });

  it('bounds every request with a timeout signal', async () => {
    const { http, calls } = scripted([new Response('ok')]);
    await fetchWithRetry('https://example.test/a', http);
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
