import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { startJob } from '../services/jobs.js';
import {
  createMemoryRateLimitStore, databaseRateLimitStore, purgeExpiredRateLimits, type RateLimitStore,
} from './rateLimitStores.js';

// Fixed-window rate limiter. Counters live in the database in production
// (RATE_LIMIT_STORE=database) so every instance draws on one count; per-process
// counters would multiply each limit by the instance count. The memory store
// remains for tests and local development.

const memoryStore = createMemoryRateLimitStore();
let storeOverride: RateLimitStore | null = null;

function activeStore(): RateLimitStore {
  if (storeOverride) return storeOverride;
  return config.rateLimitStore === 'database' ? databaseRateLimitStore : memoryStore;
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
  /**
   * Refuse the request when the store cannot be reached, instead of letting it
   * through. For limits that stand between an attacker and an account (login,
   * signup): an outage must not become an unmetered guessing window. Everything
   * else fails open, because refusing candidates mid-interview over a counter
   * is worse than a few uncounted requests.
   */
  failClosed?: boolean;
}

export type RateVerdict =
  | { allowed: true }
  | { allowed: false; retryAfter: number; reason: 'limit' | 'unavailable' };

// A database outage would otherwise log once per request.
const WARN_EVERY_MS = 60_000;
const STORE_DOWN_RETRY_SECONDS = 30;
const lastStoreWarning = new Map<string, number>();

function warnStoreFailure(name: string, err: unknown, failClosed: boolean): void {
  const now = Date.now();
  if (now - (lastStoreWarning.get(name) ?? 0) < WARN_EVERY_MS) return;
  lastStoreWarning.set(name, now);
  logger.warn(
    { limiter: name, failClosed, err: err instanceof Error ? err.message : String(err) },
    failClosed ? 'Rate-limit store unavailable; refusing requests to this limiter' : 'Rate-limit store unavailable; letting requests through uncounted',
  );
}

/**
 * Take one unit from a window, answering whether the caller is still inside
 * it. Shared by the Express middleware below and the socket transport. Returns
 * the seconds until the window resets when refused. Never throws: a store
 * failure is answered according to `failClosed`, with `retryAfter` of a few
 * seconds when refused for that reason.
 */
export async function consume(
  name: string, key: string, windowMs: number, max: number, opts: { failClosed?: boolean } = {},
): Promise<RateVerdict> {
  const now = Date.now();
  try {
    const { count, resetAt } = await activeStore().hit(`${name}:${key}`, windowMs, max, now);
    if (count > max) return { allowed: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)), reason: 'limit' };
    return { allowed: true };
  } catch (err) {
    const failClosed = opts.failClosed === true;
    warnStoreFailure(name, err, failClosed);
    return failClosed ? { allowed: false, retryAfter: STORE_DOWN_RETRY_SECONDS, reason: 'unavailable' } : { allowed: true };
  }
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, name } = opts;
  const keyOf = opts.keyOf ?? ((req: Request) => req.ip ?? 'unknown');

  return async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Tests drive endpoints in tight loops; limiting there would test the
    // limiter rather than the behaviour under test.
    if (config.nodeEnv === 'test') return next();
    if (opts.skip?.(req)) return next();

    const verdict = await consume(name, keyOf(req), windowMs, max, { failClosed: opts.failClosed });
    if (verdict.allowed) return next();
    res.setHeader('Retry-After', String(verdict.retryAfter));
    if (verdict.reason === 'unavailable') {
      res.status(503).json({
        error: 'This service is briefly unavailable. Please try again shortly.',
        retryAfterSeconds: verdict.retryAfter,
      });
      return;
    }
    // The key may be a live credential (the portal limiters key on the
    // invitation token), and a log line is not where those belong.
    logger.warn({ limiter: name, key: fingerprint(keyOf(req)), max }, 'Rate limit exceeded');
    // Deliberately generic: do not confirm whether an account or token exists.
    res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
      retryAfterSeconds: verdict.retryAfter,
    });
  };
}

/** Exported so the system health view judges the job by the same interval. */
export const RATE_LIMIT_PURGE_EVERY_MS = 10 * 60_000;

/**
 * Purge ended windows from the shared store, under a lease so one instance
 * does it. A no-op schedule when counters live in memory.
 */
export function startRateLimitPurge(intervalMs = RATE_LIMIT_PURGE_EVERY_MS): () => void {
  if (config.rateLimitStore !== 'database') return () => undefined;
  return startJob({
    name: 'rate-limit-purge',
    intervalMs,
    delayFirst: true,
    fn: async () => `purged ${await purgeExpiredRateLimits()} expired rate-limit windows`,
  });
}

/**
 * A stable, short stand-in for a bucket key, so two log lines about the same
 * caller can be matched without the log ever holding the caller's token.
 */
export function fingerprint(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Test hook — use this store instead of the configured one (null restores). */
export function _useRateLimitStore(store: RateLimitStore | null): void {
  storeOverride = store;
}

/** Test hook — clears all in-memory windows. */
export function _resetRateLimits(): void {
  memoryStore.clear();
  lastStoreWarning.clear();
}
