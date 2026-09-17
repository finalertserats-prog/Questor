import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// The limiter no-ops under NODE_ENV=test; this file tests the limiter itself.
vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return { config: { ...actual.config, nodeEnv: 'development' } };
});

const { prisma } = await import('../src/db.js');
const { rateLimit, consume, _useRateLimitStore, _resetRateLimits } = await import('../src/middleware/rateLimit.js');
const { databaseRateLimitStore, createMemoryRateLimitStore, purgeExpiredRateLimits } = await import('../src/middleware/rateLimitStores.js');
type Store = import('../src/middleware/rateLimitStores.js').RateLimitStore;

/**
 * Counters in process memory meant every limit was per instance: two instances
 * behind one proxy doubled every ceiling, including the ones bounding paid
 * transcription and the login brute-force window. The database store makes the
 * count shared; these tests pin its window behaviour and what happens when the
 * database itself is the thing failing.
 */

async function call(mw: ReturnType<typeof rateLimit>, key: string): Promise<number> {
  let status = 200;
  const req = { ip: key, path: `/${key}`, originalUrl: `/${key}` } as unknown as Request;
  const res = {
    setHeader() { /* noop */ },
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  await mw(req, res, (() => { /* next */ }) as NextFunction);
  return status;
}

const failingStore: Store = {
  name: 'database',
  hit: async () => { throw new Error('connection refused'); },
};

beforeEach(async () => {
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
});

afterEach(() => {
  _useRateLimitStore(null);
});

describe('the database rate-limit store', () => {
  it('starts a window at one', async () => {
    const hit = await databaseRateLimitStore.hit('t:a', 60_000, 5, Date.now());

    expect(hit.count).toBe(1);
  });

  it('counts further hits inside the window', async () => {
    const now = Date.now();
    await databaseRateLimitStore.hit('t:a', 60_000, 5, now);
    await databaseRateLimitStore.hit('t:a', 60_000, 5, now + 1);

    const hit = await databaseRateLimitStore.hit('t:a', 60_000, 5, now + 2);

    expect(hit.count).toBe(3);
  });

  it('keeps separate counts per key', async () => {
    const now = Date.now();
    await databaseRateLimitStore.hit('t:a', 60_000, 5, now);

    const hit = await databaseRateLimitStore.hit('t:b', 60_000, 5, now);

    expect(hit.count).toBe(1);
  });

  it('starts a fresh window once the old one has ended', async () => {
    const now = Date.now();
    await databaseRateLimitStore.hit('t:a', 60_000, 5, now);
    await databaseRateLimitStore.hit('t:a', 60_000, 5, now);

    const hit = await databaseRateLimitStore.hit('t:a', 60_000, 5, now + 60_000);

    expect(hit.count).toBe(1);
  });

  it('dates the reset from the start of the new window after a rollover', async () => {
    const now = Date.now();
    await databaseRateLimitStore.hit('t:a', 60_000, 5, now);

    const hit = await databaseRateLimitStore.hit('t:a', 60_000, 5, now + 90_000);

    expect(hit.resetAt).toBe(now + 150_000);
  });

  it('loses no hits when many arrive at once', async () => {
    const now = Date.now();
    await Promise.all(Array.from({ length: 20 }, () => databaseRateLimitStore.hit('t:burst', 60_000, 100, now)));

    const row = await prisma.rateLimitBucket.findFirstOrThrow();
    expect(row.count).toBe(20);
  });

  it('never stores the raw key, which can be a live invitation token', async () => {
    await databaseRateLimitStore.hit('portal-turn:t:secret-invitation-token', 60_000, 5, Date.now());

    const row = await prisma.rateLimitBucket.findFirstOrThrow();
    expect(row.key).not.toContain('secret-invitation-token');
  });

  it('purges windows that have ended', async () => {
    const now = Date.now();
    await databaseRateLimitStore.hit('t:old', 60_000, 5, now - 120_000);
    await databaseRateLimitStore.hit('t:new', 60_000, 5, now);

    await purgeExpiredRateLimits(new Date(now));

    expect(await prisma.rateLimitBucket.count()).toBe(1);
  });
});

describe('the limiter on the shared store', () => {
  it('refuses the request past the limit', async () => {
    _useRateLimitStore(databaseRateLimitStore);
    const mw = rateLimit({ name: 'db', windowMs: 60_000, max: 2, keyOf: (r) => String(r.ip) });
    await call(mw, 'a');
    await call(mw, 'a');

    expect(await call(mw, 'a')).toBe(429);
  });

  it('shares one count between two limiters built separately, as two instances would', async () => {
    _useRateLimitStore(databaseRateLimitStore);
    const first = rateLimit({ name: 'shared', windowMs: 60_000, max: 2, keyOf: (r) => String(r.ip) });
    const second = rateLimit({ name: 'shared', windowMs: 60_000, max: 2, keyOf: (r) => String(r.ip) });
    await call(first, 'a');
    await call(second, 'a');

    expect(await call(first, 'a')).toBe(429);
  });

  it('lets an ordinary request through when the store fails', async () => {
    _useRateLimitStore(failingStore);
    const mw = rateLimit({ name: 'ordinary', windowMs: 60_000, max: 2 });

    expect(await call(mw, 'a')).toBe(200);
  });

  it('refuses a login-class request when the store fails', async () => {
    _useRateLimitStore(failingStore);
    const mw = rateLimit({ name: 'login', windowMs: 60_000, max: 2, failClosed: true });

    expect(await call(mw, 'a')).toBe(503);
  });

  it('reports a failing store as refused to a fail-closed socket caller', async () => {
    _useRateLimitStore(failingStore);

    const verdict = await consume('socket-start', 's1', 60_000, 5, { failClosed: true });

    expect(verdict.allowed).toBe(false);
  });

  it('reports a failing store as allowed to a fail-open socket caller', async () => {
    _useRateLimitStore(failingStore);

    const verdict = await consume('socket-start', 's1', 60_000, 5);

    expect(verdict.allowed).toBe(true);
  });
});

describe('the memory rate-limit store', () => {
  it('starts a fresh window once the old one has ended', async () => {
    const store = createMemoryRateLimitStore();
    const now = Date.now();
    await store.hit('t:a', 60_000, 5, now);

    const hit = await store.hit('t:a', 60_000, 5, now + 60_000);

    expect(hit.count).toBe(1);
  });

  it('counts hits inside the window', async () => {
    const store = createMemoryRateLimitStore();
    const now = Date.now();
    await store.hit('t:a', 60_000, 5, now);

    const hit = await store.hit('t:a', 60_000, 5, now + 10);

    expect(hit.count).toBe(2);
  });
});
