import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Fixed-window in-memory rate limiter. Questor is deployed as a single process
// on one machine, so a shared store (Redis) would be complexity without
// benefit; if this ever runs multi-instance this must be replaced, because
// per-process counters would multiply the effective limit by the instance count.

// `max` is carried on the bucket so eviction can tell an exhausted key from a
// quiet one without knowing which limiter created it.
interface Bucket { count: number; resetAt: number; max: number }

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

// Keys can be attacker-chosen (an invitation token in the path), so expiry-only
// cleanup is not enough: a flood of random tokens creates a bucket each and the
// map grows until the window rolls. The map is therefore capped — but WHAT gets
// evicted is a security decision, not a housekeeping one.
const MAX_BUCKETS = 50_000;

function sweep(now: number) {
  if (now - lastSweep >= 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  if (buckets.size <= MAX_BUCKETS) return;

  // Evicting oldest-inserted first was exploitable: an attacker who exhausted
  // their own limit could flood ~50k junk keys and push their own spent bucket
  // out of the map, which resets their count to zero. That defeats every
  // token-keyed limit in the app, including the ones bounding paid TTS and
  // transcription spend.
  //
  // So evict in order of least security value: expired windows first, then
  // keys still under their limit, and NEVER a key that is currently over it.
  // A saturated bucket is the one piece of state actually holding an attacker
  // back, so it is the last thing to go.
  let excess = buckets.size - MAX_BUCKETS;

  for (const [k, b] of buckets) {
    if (excess <= 0) break;
    if (b.resetAt <= now) { buckets.delete(k); excess--; }
  }
  for (const [k, b] of buckets) {
    if (excess <= 0) break;
    if (b.count < b.max) { buckets.delete(k); excess--; }
  }
  // If every remaining bucket is over its limit the map stays above the cap.
  // That is the correct trade: memory is bounded by MAX_BUCKETS plus however
  // many keys are genuinely rate-limited right now, and letting it grow beats
  // handing out free resets.
  if (excess > 0) {
    logger.warn({ over: excess, size: buckets.size },
      'Rate-limit table above cap and every candidate for eviction is over its limit — possible flood in progress');
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
  /** Requests for which this limiter does not count or block. */
  skip?: (req: Request) => boolean;
}

/**
 * Take one unit from a window, answering whether the caller is still inside
 * it. Shared by the Express middleware below and the socket transport, which
 * used to have no per-invitation limit at all while the equivalent HTTP
 * routes did. Returns the seconds until the window resets when refused.
 */
export function consume(name: string, key: string, windowMs: number, max: number): { allowed: true } | { allowed: false; retryAfter: number } {
  const now = Date.now();
  sweep(now);
  const bucketKey = `${name}:${key}`;
  const bucket = buckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs, max });
    return { allowed: true };
  }
  bucket.count += 1;
  if (bucket.count > max) return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  return { allowed: true };
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, name } = opts;
  const keyOf = opts.keyOf ?? ((req: Request) => req.ip ?? 'unknown');

  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    // Tests drive endpoints in tight loops; limiting there would test the
    // limiter rather than the behaviour under test.
    if (config.nodeEnv === 'test') return next();
    if (opts.skip?.(req)) return next();

    const verdict = consume(name, keyOf(req), windowMs, max);
    if (!verdict.allowed) {
      const retryAfter = verdict.retryAfter;
      const bucket = { count: max + 1 };
      res.setHeader('Retry-After', String(retryAfter));
      // The key may be a live credential (the portal limiters key on the
      // invitation token), and a log line is not where those belong.
      logger.warn({ limiter: name, key: fingerprint(keyOf(req)), count: bucket.count }, 'Rate limit exceeded');
      // Deliberately generic: do not confirm whether an account or token exists.
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
        retryAfterSeconds: retryAfter,
      });
    }
    return next();
  };
}

/**
 * A stable, short stand-in for a bucket key, so two log lines about the same
 * caller can be matched without the log ever holding the caller's token.
 */
export function fingerprint(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Test hook — clears all windows. */
export function _resetRateLimits() {
  buckets.clear();
}
