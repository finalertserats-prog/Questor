import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Fixed-window in-memory rate limiter. Questor is deployed as a single process
// on one machine, so a shared store (Redis) would be complexity without
// benefit; if this ever runs multi-instance this must be replaced, because
// per-process counters would multiply the effective limit by the instance count.

interface Bucket { count: number; resetAt: number }

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

// Keys can be attacker-chosen (an invitation token in the path), so expiry-only
// cleanup is not enough: a flood of random tokens creates a bucket each and the
// map grows until the window rolls. Cap the map and evict oldest-first.
const MAX_BUCKETS = 50_000;

function sweep(now: number) {
  if (now - lastSweep >= 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  if (buckets.size <= MAX_BUCKETS) return;
  // Map preserves insertion order, so the head is the oldest window.
  const excess = buckets.size - MAX_BUCKETS;
  let removed = 0;
  for (const k of buckets.keys()) {
    buckets.delete(k);
    if (++removed >= excess) break;
  }
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per key per window. */
  max: number;
  /** Label used in logs and the error message. */
  name: string;
  /** Derive the bucket key. Defaults to client IP. */
  keyOf?: (req: Request) => string;
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, name } = opts;
  const keyOf = opts.keyOf ?? ((req: Request) => req.ip ?? 'unknown');

  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    // Tests drive endpoints in tight loops; limiting there would test the
    // limiter rather than the behaviour under test.
    if (config.nodeEnv === 'test') return next();

    const now = Date.now();
    sweep(now);
    const key = `${name}:${keyOf(req)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      logger.warn({ limiter: name, key: keyOf(req), count: bucket.count }, 'Rate limit exceeded');
      // Deliberately generic: do not confirm whether an account or token exists.
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
        retryAfterSeconds: retryAfter,
      });
    }
    return next();
  };
}

/** Test hook — clears all windows. */
export function _resetRateLimits() {
  buckets.clear();
}
