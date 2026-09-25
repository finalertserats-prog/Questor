import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * Where fixed-window rate-limit counts live.
 *
 * `hit` records one request against `key` and reports the window's count
 * including it. The memory store is per process; the database store is shared
 * by every instance, so a second instance no longer doubles each limit.
 */
export interface RateLimitStore {
  readonly name: 'memory' | 'database';
  hit(key: string, windowMs: number, max: number, now: number): Promise<{ count: number; resetAt: number }>;
  /**
   * The window's count WITHOUT adding to it, so a limiter can refuse a caller
   * that is already over without charging every request. The login limiter
   * needs this: it charges failures only, and counting a success is what
   * locked out an office behind one NAT
   * (docs/qa/resilience-2026-09-23.md, S1).
   *
   * `count` is 0 when no window is open.
   */
  peek(key: string, windowMs: number, now: number): Promise<{ count: number; resetAt: number }>;
}

// ---- Memory ----

// `max` is carried on the bucket so eviction can tell an exhausted key from a
// quiet one without knowing which limiter created it.
interface Bucket { count: number; resetAt: number; max: number }

// Keys can be attacker-chosen (an invitation token in the path), so expiry-only
// cleanup is not enough: a flood of random tokens creates a bucket each and the
// map grows until the window rolls. The map is therefore capped — but WHAT gets
// evicted is a security decision, not a housekeeping one.
const MAX_BUCKETS = 50_000;

export interface MemoryRateLimitStore extends RateLimitStore {
  clear(): void;
}

export function createMemoryRateLimitStore(): MemoryRateLimitStore {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  function sweep(now: number) {
    if (now - lastSweep >= 60_000) {
      lastSweep = now;
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    }
    if (buckets.size <= MAX_BUCKETS) return;

    // Evicting oldest-inserted first was exploitable: an attacker who exhausted
    // their own limit could flood ~50k junk keys and push their own spent bucket
    // out of the map, which resets their count to zero. So evict in order of
    // least security value: expired windows first, then keys still under their
    // limit, and NEVER a key that is currently over it.
    let excess = buckets.size - MAX_BUCKETS;
    for (const [k, b] of buckets) {
      if (excess <= 0) break;
      if (b.resetAt <= now) { buckets.delete(k); excess--; }
    }
    for (const [k, b] of buckets) {
      if (excess <= 0) break;
      if (b.count < b.max) { buckets.delete(k); excess--; }
    }
    // Memory stays bounded by MAX_BUCKETS plus the keys genuinely rate-limited
    // right now; letting it grow beats handing out free resets.
    if (excess > 0) {
      logger.warn({ over: excess, size: buckets.size },
        'Rate-limit table above cap and every candidate for eviction is over its limit — possible flood in progress');
    }
  }

  return {
    name: 'memory',
    async hit(key, windowMs, max, now) {
      sweep(now);
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        const fresh = { count: 1, resetAt: now + windowMs, max };
        buckets.set(key, fresh);
        return { count: 1, resetAt: fresh.resetAt };
      }
      bucket.count += 1;
      return { count: bucket.count, resetAt: bucket.resetAt };
    },
    async peek(key, windowMs, now) {
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) return { count: 0, resetAt: now + windowMs };
      return { count: bucket.count, resetAt: bucket.resetAt };
    },
    clear() {
      buckets.clear();
    },
  };
}

// ---- Database ----

/**
 * The stored key. Caller keys can be invitation tokens — live credentials the
 * invitation table itself no longer holds in the clear — so only a digest is
 * written. The limiter name stays readable for the operations view.
 */
function storedKey(key: string): string {
  const cut = key.indexOf(':');
  const name = cut > 0 ? key.slice(0, cut) : 'limit';
  return `${name}:${crypto.createHash('sha256').update(key).digest('hex')}`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025';
}

// Each attempt is at most three statements, and each statement decides on its
// own; a retry is needed only when two callers race to create the same row.
const MAX_ATTEMPTS = 4;

/**
 * Every write is a single conditional statement, so no count is read and then
 * written back:
 *   1. increment the row if its window is still open;
 *   2. otherwise restart the window if the row exists but has expired — the
 *      expiry in the WHERE clause means only one racer can win the restart;
 *   3. otherwise create it; a unique violation means another caller just did,
 *      and the loop goes round to increment theirs.
 * The increment and its read-back share a transaction (see below).
 */
export const databaseRateLimitStore: RateLimitStore = {
  name: 'database',
  async hit(key, windowMs, _max, now) {
    const id = storedKey(key);
    const at = new Date(now);
    const expiresAt = new Date(now + windowMs);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // `update`, not updateMany + findUnique: the engine returns the row this
      // increment produced within the same write, so the count is this hit's
      // own. Read separately, a burst's early requests could see later
      // requests' increments and be refused although they were within the
      // limit. (An interactive transaction would do the same on Postgres but
      // times out under concurrency on SQLite's single connection.)
      const bumped = await prisma.rateLimitBucket.update({
        where: { key: id, expiresAt: { gt: at } },
        data: { count: { increment: 1 } },
        select: { count: true, expiresAt: true },
      }).catch((err: unknown) => {
        if (isNotFound(err)) return null; // window closed, or no row yet
        throw err;
      });
      if (bumped) return { count: bumped.count, resetAt: bumped.expiresAt.getTime() };

      const restarted = await prisma.rateLimitBucket.updateMany({
        where: { key: id, expiresAt: { lte: at } },
        data: { count: 1, windowStart: at, expiresAt },
      });
      if (restarted.count === 1) return { count: 1, resetAt: expiresAt.getTime() };

      try {
        await prisma.rateLimitBucket.create({ data: { key: id, windowStart: at, count: 1, expiresAt } });
        return { count: 1, resetAt: expiresAt.getTime() };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new Error('Could not record a rate-limit hit: the bucket kept changing underneath');
  },

  async peek(key, windowMs, now) {
    const row = await prisma.rateLimitBucket.findUnique({ where: { key: storedKey(key) }, select: { count: true, expiresAt: true } });
    if (!row || row.expiresAt.getTime() <= now) return { count: 0, resetAt: now + windowMs };
    return { count: row.count, resetAt: row.expiresAt.getTime() };
  },
};

/** Delete windows that have ended. Returns how many rows went. */
export async function purgeExpiredRateLimits(now = new Date()): Promise<number> {
  const { count } = await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}
