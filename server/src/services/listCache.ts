import crypto from 'node:crypto';

/**
 * A few seconds' memory for the two reads on the operator lists that cost the
 * whole tenant rather than the page.
 *
 * Both were measured at 5,000 candidates / 20,000 interviews
 * (docs/qa/resilience-2026-09-23.md §2.2): the state summary is "across every
 * page" by definition, and the search match is computed in the application
 * because `mode: 'insensitive'` does not exist on SQLite. Neither can be made
 * to scale with the page by asking a better question — they are tenant-wide
 * answers. What they can stop doing is being recomputed for every request.
 *
 * Two properties make this worth having:
 *
 *   single flight  ten operators refreshing the list at the same moment used
 *                  to run ten identical whole-tenant queries (3.1 s wall).
 *                  They now share one, because the in-flight PROMISE is what
 *                  is stored, not its result.
 *   short life     a page refresh, paging through search results, and a
 *                  re-render all land inside the window.
 *
 * WHAT IT COSTS. A count can be up to TTL_MS out of date. It is a summary of
 * how many people sit in each state, shown beside a list whose own rows are
 * always read fresh — a few seconds behind is invisible, and the same request
 * a moment later is right. Nothing here is ever used to decide anything.
 *
 * Per process and deliberately small: this is a latency smoother, not a
 * cache layer, and a bounded map cannot become a memory leak.
 */

const TTL_MS = 10_000;
/** Above this, the coldest entries go. Tens of operators, a handful of searches each. */
const MAX_ENTRIES = 64;

interface Entry {
  readonly value: Promise<unknown>;
  readonly at: number;
}

const entries = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [key, entry] of entries) if (now - entry.at >= TTL_MS) entries.delete(key);
  if (entries.size <= MAX_ENTRIES) return;
  // Insertion order is age order: the oldest live entries go first.
  for (const key of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    entries.delete(key);
  }
}

/**
 * `compute()` at most once per key per window. A rejection is never cached:
 * the entry is dropped so the next caller tries again rather than inheriting
 * a failure for the rest of the window.
 */
export async function memoBriefly<T>(key: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
  sweep(now);
  const hit = entries.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = compute();
  entries.set(key, { value, at: now });
  try {
    return await value;
  } catch (err) {
    if (entries.get(key)?.value === value) entries.delete(key);
    throw err;
  }
}

/**
 * A stable short key for a Prisma `where`. The scope can carry candidate and
 * role ids, which is exactly the sort of thing that does not belong in a map
 * key that might be logged, so it is hashed rather than stringified.
 */
export function shapeKey(parts: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts ?? null)).digest('hex').slice(0, 16);
}

/** Test hook — forget everything. */
export function _clearListCache(): void {
  entries.clear();
}

export const LIST_CACHE_TTL_MS = TTL_MS;
