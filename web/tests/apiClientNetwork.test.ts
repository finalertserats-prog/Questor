import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { NETWORK_MESSAGE } from '../src/api/responseModel';

/**
 * A request that never reaches the server used to surface the browser's own
 * "Failed to fetch" on the page. The shared client turns it into plain words
 * and still reports it as an ApiError with status 0, so callers that handle
 * "no answer" differently from a refusal keep doing so.
 */

afterEach(() => { vi.unstubAllGlobals(); });

async function failure(): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  return api.get('/candidates').then(() => null, (err: unknown) => err);
}

describe('api client when the network fails', () => {
  it('throws an ApiError', async () => {
    expect(await failure()).toBeInstanceOf(ApiError);
  });

  it('uses the plain-language message', async () => {
    expect((await failure() as ApiError).message).toBe(NETWORK_MESSAGE);
  });

  it('reports status 0, meaning no answer', async () => {
    expect((await failure() as ApiError).status).toBe(0);
  });

  it('leaves other failures as they were', async () => {
    const boom = new RangeError('unexpected');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(boom));
    expect(await api.get('/x').then(() => null, (err: unknown) => err)).toBe(boom);
  });
});
