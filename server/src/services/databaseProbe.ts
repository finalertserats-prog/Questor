import { prisma } from '../db.js';

/**
 * "Can this process reach its database?" for the public /api/health.
 *
 * Without it the health check answered "ok" through a 15-minute outage in
 * which every database call failed (2026-09-18: a deploy generated the wrong
 * Prisma client), and so did the deploy's verify step, which reads it.
 *
 * The endpoint is unauthenticated and polled by uptime checks, so the probe is
 * one trivial query, bounded by a deadline so a hung connection cannot hang
 * the check, and shared by every check that arrives while it is in flight so
 * a burst of polls is one query, not a burst of them. When the database stops
 * answering altogether, a new query is tried at most once per abandon window.
 */

export const DATABASE_PROBE_TIMEOUT_MS = 2000;
// How long a query that never answers is waited on before a fresh one is
// tried. Without a limit, one query lost for good would keep the check
// "unavailable" after the database came back; with it, a dead database costs
// at most one new query per window.
export const STUCK_PING_ABANDON_MS = 30_000;

type Ping = () => Promise<unknown>;

const defaultPing: Ping = () => prisma.$queryRaw`SELECT 1`;

let inFlight: Promise<boolean> | null = null;
// The query itself, kept until it settles rather than until the deadline. A
// database that hangs instead of refusing would otherwise leave one stuck query
// behind per poll, every 2 s, for as long as the outage lasts.
let pendingPing: Promise<unknown> | null = null;
let pendingSince = 0;

function startPing(ping: Ping, abandonMs: number): Promise<unknown> {
  if (pendingPing && Date.now() - pendingSince >= abandonMs) pendingPing = null;
  if (!pendingPing) {
    // Promise.resolve: Prisma's query promise is lazy, and wrapping it once
    // makes sure the two listeners below run one query, not two.
    const settled = Promise.resolve(ping());
    pendingPing = settled;
    pendingSince = Date.now();
    const clear = () => { if (pendingPing === settled) pendingPing = null; };
    settled.then(clear, clear);
  }
  return pendingPing;
}

async function runProbe(ping: Ping, timeoutMs: number, abandonMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([startPing(ping, abandonMs).then(() => true as const), deadline]);
  } catch {
    // The reason stays out of the public answer; the process log already has
    // every failed query from the requests that hit it.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function probeDatabase(
  ping: Ping = defaultPing,
  timeoutMs = DATABASE_PROBE_TIMEOUT_MS,
  abandonMs = STUCK_PING_ABANDON_MS,
): Promise<boolean> {
  if (!inFlight) {
    inFlight = runProbe(ping, timeoutMs, abandonMs).finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** For tests: forget a ping a test left hung on purpose. */
export function resetDatabaseProbe(): void {
  inFlight = null;
  pendingPing = null;
}
