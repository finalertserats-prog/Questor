import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// The limiter no-ops under NODE_ENV=test (so suites are not testing the
// limiter instead of the behaviour under test), so this file forces it on.
vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return { config: { ...actual.config, nodeEnv: 'development' } };
});

const { rateLimit, _resetRateLimits } = await import('../src/middleware/rateLimit.js');

function call(mw: ReturnType<typeof rateLimit>, key: string): number {
  let status = 200;
  const req = { ip: key, path: `/${key}`, originalUrl: `/${key}` } as unknown as Request;
  const res = {
    setHeader() { /* noop */ },
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  mw(req, res, (() => { /* next */ }) as NextFunction);
  return status;
}

describe('rate limiter', () => {
  beforeEach(() => _resetRateLimits());

  it('allows up to the limit and rejects beyond it', () => {
    const mw = rateLimit({ name: 't', windowMs: 60_000, max: 3, keyOf: (r) => String(r.ip) });
    expect(call(mw, 'a')).toBe(200);
    expect(call(mw, 'a')).toBe(200);
    expect(call(mw, 'a')).toBe(200);
    expect(call(mw, 'a')).toBe(429);
  });

  it('keeps separate counts per key', () => {
    const mw = rateLimit({ name: 't', windowMs: 60_000, max: 1, keyOf: (r) => String(r.ip) });
    expect(call(mw, 'a')).toBe(200);
    expect(call(mw, 'a')).toBe(429);
    expect(call(mw, 'b')).toBe(200);
  });

  // The exploit: eviction used to drop oldest-INSERTED first, so an attacker who
  // had exhausted their limit could flood junk keys until their own spent bucket
  // was pushed out of the map — resetting their count and defeating the spend
  // ceiling on the paid TTS and transcription routes.
  it('does not reset an exhausted key when the table is flooded with new keys', () => {
    const mw = rateLimit({ name: 'flood', windowMs: 60_000, max: 2, keyOf: (r) => String(r.ip) });

    // Attacker exhausts their own limit first, so their bucket is the oldest.
    expect(call(mw, 'attacker')).toBe(200);
    expect(call(mw, 'attacker')).toBe(200);
    expect(call(mw, 'attacker')).toBe(429);

    // Flood well past MAX_BUCKETS (50k) to force eviction.
    for (let i = 0; i < 60_000; i++) call(mw, `junk-${i}`);

    // Still blocked. Under the old oldest-first eviction this returned 200.
    expect(call(mw, 'attacker')).toBe(429);
  }, 30_000);
});
