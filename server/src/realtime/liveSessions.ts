import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * Which interviews THIS process is serving right now, for the shutdown drain.
 *
 * The web room runs over plain HTTP (start, then one request per answer), and
 * the socket carries the same events for other clients, so "live" cannot mean
 * "has an open connection". It means: a candidate touched the session through
 * this process recently, or still holds a socket to it, AND the session is in a
 * state where the interview is still happening. The database answers the
 * second half; this module remembers the first.
 *
 * Deliberately per process. Another instance's interviews are that instance's
 * drain to wait for, and counting them here would hold a restart hostage to
 * traffic it is not serving.
 */

/**
 * A candidate silent for this long is treated as gone for drain purposes. It
 * matches the deploy script's own "active in the last 15 minutes" test, and is
 * far longer than anyone takes to answer one question.
 */
export const DRAIN_IDLE_MS = 15 * 60_000;

/**
 * States in which ending the process would cut something off: the conversation
 * itself, and the finalisation that runs in-process after the sign-off.
 *
 * Pre-start states (disclosure, consent, warm-up) are deliberately absent. A
 * draining process refuses to start those interviews, so a candidate sitting
 * on the consent page would otherwise hold the restart for the whole window
 * waiting for an interview that cannot begin here.
 */
export const UNDER_WAY_STATES: readonly string[] = ['ASSESSING', 'CANDIDATE_QUESTIONS', 'CLOSING', 'PROCESSING'];

const lastActivity = new Map<string, number>();
const candidateSockets = new Map<string, number>();
let requestsInFlight = 0;

export function noteSessionActivity(sessionId: string, now = Date.now()): void {
  lastActivity.set(sessionId, now);
}

/** Record a candidate socket attached to a session; returns its release. */
export function holdCandidateSocket(sessionId: string): () => void {
  candidateSockets.set(sessionId, (candidateSockets.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (candidateSockets.get(sessionId) ?? 1) - 1;
    if (left <= 0) candidateSockets.delete(sessionId);
    else candidateSockets.set(sessionId, left);
  };
}

/** Mark one request or socket event as running; returns its completion. */
export function beginRequest(): () => void {
  requestsInFlight += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    requestsInFlight -= 1;
  };
}

export function inFlightRequests(): number {
  return requestsInFlight;
}

/**
 * How many interviews this process would cut off if it exited now.
 *
 * If the database cannot be asked, every recently-touched session is counted:
 * guessing "idle" is how a drain ends an interview it was meant to protect.
 */
export async function countLiveSessions(now = Date.now()): Promise<number> {
  for (const [id, at] of lastActivity) {
    if (now - at > DRAIN_IDLE_MS) lastActivity.delete(id);
  }
  const ids = [...new Set([...lastActivity.keys(), ...candidateSockets.keys()])];
  if (ids.length === 0) return 0;
  try {
    return await prisma.interviewSession.count({ where: { id: { in: ids }, state: { in: [...UNDER_WAY_STATES] } } });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), sessions: ids.length },
      'Could not check interview states during drain; counting every recent session as live');
    return ids.length;
  }
}

/** Test hook. */
export function _resetLiveSessions(): void {
  lastActivity.clear();
  candidateSockets.clear();
  requestsInFlight = 0;
}
