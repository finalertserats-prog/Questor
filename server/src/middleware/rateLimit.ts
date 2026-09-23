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

/**
 * Ask whether a caller is already over a limit, without charging them for
 * asking. Same contract as `consume` otherwise, including `failClosed`.
 */
export async function inspect(
  name: string, key: string, windowMs: number, max: number, opts: { failClosed?: boolean } = {},
): Promise<RateVerdict> {
  const now = Date.now();
  try {
    const { count, resetAt } = await activeStore().peek(`${name}:${key}`, windowMs, now);
    if (count >= max) return { allowed: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)), reason: 'limit' };
    return { allowed: true };
  } catch (err) {
    const failClosed = opts.failClosed === true;
    warnStoreFailure(name, err, failClosed);
    return failClosed ? { allowed: false, retryAfter: STORE_DOWN_RETRY_SECONDS, reason: 'unavailable' } : { allowed: true };
  }
}

// Tests drive endpoints in tight loops, so limiting there would test the
// limiter rather than the behaviour under test — which is why every limiter is
// off under NODE_ENV=test. The cost was that NO shipped test covered ANY limit
// (docs/qa/resilience-2026-09-23.md, §3.3), so the defects in them were found
// by driving a server by hand. A test that is about a limit now opts in.
let enabledInTests = false;

/** Test hook: run the limiters in this file although NODE_ENV is 'test'. Turn it off again in afterEach. */
export function _enableRateLimitsInTests(on = true): void {
  enabledInTests = on;
}

function limitersActive(): boolean {
  return config.nodeEnv !== 'test' || enabledInTests;
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, name } = opts;
  const keyOf = opts.keyOf ?? ((req: Request) => req.ip ?? 'unknown');

  return async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!limitersActive()) return next();
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

/**
 * How many FAILED sign-ins one account tolerates in a window. Tight, because
 * this is the number that stands between someone guessing and someone's
 * password. Successes never count: a person signing in is not an attack.
 */
export const LOGIN_FAILURES_PER_ACCOUNT = 10;

/**
 * How many failed sign-ins one client address tolerates in a window. Far
 * looser than the per-account ceiling, and deliberately so: a whole office
 * shares one address behind NAT, and several colleagues each mistyping a
 * password is ordinary. This bucket exists for one address grinding through
 * MANY accounts, which the per-account ceiling cannot see.
 */
export const LOGIN_FAILURES_PER_ADDRESS = 100;

export const LOGIN_WINDOW_MS = 15 * 60_000;

/**
 * Which answers charge the SUBJECT (account) bucket: a refused credential,
 * and nothing else.
 *
 * Deliberately not 400. A malformed body is not evidence about the password,
 * and charging it would hand anyone an account-lockout button: send a dozen
 * unparseable bodies carrying someone's address and they cannot sign in.
 */
const SUBJECT_FAILURE = (status: number): boolean => status === 401 || status === 403;

/**
 * Which answers charge the ADDRESS bucket: the above, plus anything the
 * server refused as a bad request. That bucket is per address and very loose,
 * so it costs a person nothing and still meters a flood of garbage.
 */
const ADDRESS_FAILURE = (status: number): boolean => SUBJECT_FAILURE(status) || status === 400;

export interface FailureRateLimitOptions {
  readonly name: string;
  readonly windowMs: number;
  /** The tight per-subject ceiling (an account). */
  readonly max: number;
  /** The loose per-address ceiling. */
  readonly addressMax: number;
  /** The subject this attempt is against — an account. null when the request names none. */
  readonly subjectOf: (req: Request) => string | null;
  readonly failClosed?: boolean;
}

/**
 * A limiter that charges for FAILURES rather than for requests.
 *
 * The login limiter used to consume a unit before the handler ran, so ten
 * successful sign-ins from one office exhausted it and the eleventh colleague
 * could not work (S1). Counting only what failed keeps the brute-force bound
 * — an attacker's attempts all fail by definition — while costing a person
 * who signs in correctly nothing at all.
 *
 * Two buckets, checked before and charged after:
 *   subject  the account being signed in to, so a new address does not reset
 *            a guessing run, and one account under attack never takes a
 *            colleague's sign-in down with it;
 *   address  a much looser ceiling for one address working through many
 *            accounts, which no per-account bucket can see.
 *
 * HONEST LIMIT: the check does not consume, so N requests that arrive
 * together can all pass one check before any of them has failed. The
 * overshoot is bounded by concurrency, not by the window, and the bucket
 * still closes once those failures land. A guess is only ever worth making
 * serially, so this costs an attacker nothing they did not already have.
 */
export function failureRateLimit(opts: FailureRateLimitOptions) {
  return async function failureRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!limitersActive()) return next();

    const subject = opts.subjectOf(req);
    const buckets: Array<{ key: string; max: number; charges: (status: number) => boolean }> = [
      { key: `ip:${req.ip ?? 'unknown'}`, max: opts.addressMax, charges: ADDRESS_FAILURE },
      ...(subject ? [{ key: subject, max: opts.max, charges: SUBJECT_FAILURE }] : []),
    ];

    for (const bucket of buckets) {
      const verdict = await inspect(opts.name, bucket.key, opts.windowMs, bucket.max, { failClosed: opts.failClosed });
      if (verdict.allowed) continue;
      res.setHeader('Retry-After', String(verdict.retryAfter));
      if (verdict.reason === 'unavailable') {
        res.status(503).json({ error: 'This service is briefly unavailable. Please try again shortly.', retryAfterSeconds: verdict.retryAfter });
        return;
      }
      logger.warn({ limiter: opts.name, key: fingerprint(bucket.key), max: bucket.max }, 'Rate limit exceeded');
      // Deliberately generic: do not confirm whether an account exists.
      res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.', retryAfterSeconds: verdict.retryAfter });
      return;
    }

    // Charged once the answer is known. 'finish' fires for every response the
    // server completes, including one an error handler wrote.
    res.once('finish', () => {
      for (const bucket of buckets) {
        if (!bucket.charges(res.statusCode)) continue;
        consume(opts.name, bucket.key, opts.windowMs, bucket.max, { failClosed: opts.failClosed })
          .catch((err: unknown) => logger.warn({ limiter: opts.name, err: String(err) }, 'Could not record a failed attempt'));
      }
    });
    next();
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
