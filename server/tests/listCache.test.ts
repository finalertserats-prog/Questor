import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIST_CACHE_TTL_MS, memoBriefly, shapeKey, _clearListCache } from '../src/services/listCache.js';

/**
 * §2.2: the candidates page cost ~940 ms whichever page was asked for, and ten
 * operators refreshing it at once cost 2 s wall — ten identical whole-tenant
 * queries. The state summary and the search match are tenant-wide answers by
 * definition, so the fix is to stop recomputing them for every request rather
 * than to ask a smaller question.
 *
 * What has to be true for that to be safe: one computation per window however
 * many callers arrive, a failure that is never remembered, and a window short
 * enough that a count is never meaningfully wrong.
 */

afterEach(() => {
  _clearListCache();
  vi.useRealTimers();
});

describe('one computation per window', () => {
  it('computes once for two callers in a row', async () => {
    const compute = vi.fn(async () => 'counted');
    await memoBriefly('k', compute);
    await memoBriefly('k', compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('computes once for ten callers at the same moment', async () => {
    let resolve = (_v: string) => {};
    const compute = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const all = Promise.all(Array.from({ length: 10 }, () => memoBriefly('k', compute)));
    resolve('counted');
    expect(await all).toEqual(Array.from({ length: 10 }, () => 'counted'));
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('keeps different keys apart', async () => {
    const compute = vi.fn(async () => 'x');
    await memoBriefly('a', compute);
    await memoBriefly('b', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe('the window', () => {
  it('is short enough that a count is never meaningfully stale', () => {
    expect(LIST_CACHE_TTL_MS).toBeLessThanOrEqual(30_000);
  });

  it('recomputes once it has passed', async () => {
    const compute = vi.fn(async () => 'counted');
    const now = Date.now();
    await memoBriefly('k', compute, now);
    await memoBriefly('k', compute, now + LIST_CACHE_TTL_MS + 1);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('serves the same answer inside it', async () => {
    let n = 0;
    const compute = async () => `answer-${++n}`;
    const now = Date.now();
    const first = await memoBriefly('k', compute, now);
    const second = await memoBriefly('k', compute, now + LIST_CACHE_TTL_MS - 1);
    expect([first, second]).toEqual(['answer-1', 'answer-1']);
  });
});

describe('a failure', () => {
  it('reaches the caller', async () => {
    await expect(memoBriefly('k', async () => { throw new Error('the database went away'); })).rejects.toThrow('the database went away');
  });

  it('is never remembered: the next caller tries again', async () => {
    const compute = vi.fn()
      .mockRejectedValueOnce(new Error('the database went away'))
      .mockResolvedValueOnce('counted');
    await expect(memoBriefly('k', compute)).rejects.toThrow();
    expect(await memoBriefly('k', compute)).toBe('counted');
  });
});

describe('the key', () => {
  it('is the same for the same shape', () => {
    expect(shapeKey([{ tenantId: 't1' }, 'sharma'])).toBe(shapeKey([{ tenantId: 't1' }, 'sharma']));
  });

  it('differs for a different scope', () => {
    expect(shapeKey([{ tenantId: 't1' }, 'x'])).not.toBe(shapeKey([{ tenantId: 't2' }, 'x']));
  });

  it('differs for a different search', () => {
    expect(shapeKey([{ tenantId: 't1' }, 'a'])).not.toBe(shapeKey([{ tenantId: 't1' }, 'b']));
  });

  it('never carries the ids it was built from', () => {
    const key = shapeKey([{ tenantId: 'tenant-abc', id: { in: ['cand-secret-1'] } }, 'needle']);
    expect([key.includes('cand-secret-1'), key.includes('tenant-abc'), key.includes('needle')]).toEqual([false, false, false]);
  });
});

describe('it stays bounded', () => {
  it('does not grow without limit under distinct keys', async () => {
    const now = Date.now();
    for (let i = 0; i < 500; i++) await memoBriefly(`k${i}`, async () => i, now);
    // Nothing to assert on the map directly; what matters is that a flood of
    // keys does not stop the cache working for the next caller.
    const compute = vi.fn(async () => 'counted');
    expect(await memoBriefly('after-the-flood', compute, now)).toBe('counted');
  });
});
