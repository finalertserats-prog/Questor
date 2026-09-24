import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma } from '../db.js';

/**
 * What a demo sandbox may not do, kept free of the rest of the demo service so
 * the LLM provider and the email call sites can import it without a cycle.
 */

interface DemoContext {
  readonly heuristicOnly: boolean;
}

const demoContext = new AsyncLocalStorage<DemoContext>();

/**
 * Run `fn` as part of a demo: model calls made inside it, however deep, fall
 * back to the built-in heuristic engine. Set by `authenticate` for a demo
 * session, so work a demo visitor starts (role extraction, scoring) never
 * spends on a paid model.
 */
export function runAsDemo<T>(fn: () => T): T {
  return demoContext.run({ heuristicOnly: true }, fn);
}

/**
 * Whether a demo session token is still good: the same test `authenticate`
 * applies to HTTP, for transports (the interview socket) that check it themselves.
 */
export async function demoSessionLive(claims: { demo?: boolean; demoGrantId?: string; userId: string; tenantId: string }): Promise<boolean> {
  if (claims.demo !== true) return true;
  const grant = await prisma.demoGrant.findUnique({ where: { id: claims.demoGrantId ?? '' }, select: { sessionEndsAt: true, userId: true, tenantId: true } });
  return !!grant && grant.userId === claims.userId && grant.tenantId === claims.tenantId && !!grant.sessionEndsAt && grant.sessionEndsAt.getTime() > Date.now();
}

export function inDemoContext(): boolean {
  return demoContext.getStore()?.heuristicOnly === true;
}

/** How every refusal of a write reads in a demo: a description, not an error. */
export const DEMO_READ_ONLY_MESSAGE = 'This part of Questor is read-only in the demo.';

/**
 * Which ways of sitting the sample interview a demo offers right now. The
 * guided tour's closing card renders exactly these and nothing else: an
 * option that is not offered is simply absent — no greyed button, no
 * explanation. Nothing below the product's standard is ever served, so there
 * is nothing to disclaim.
 *
 * Both switches belong to the demo-interview lane (feature/demo-interview):
 * `candidate` becomes true once the candidate-side interview runs on the
 * production model within its budget — a demo session is heuristic-only
 * (runAsDemo) until then; `observer` becomes true when the scripted observer
 * interview ships. The tour only reads them.
 */
export interface DemoInterviewModes { readonly candidate: boolean; readonly observer: boolean }

export function demoInterviewModes(): DemoInterviewModes {
  return { candidate: false, observer: false };
}

/**
 * THE ONE PLACE A DEMO MAY SPEND ON A REAL MODEL, AND THE WHOLE OF IT.
 *
 * Everything above this line still holds: a demo session is heuristic-only,
 * and every interview in a demo tenant is heuristic-only. The owner's decision
 * of 2026-09-24 carved out a single exception — the interviewer REACTING to
 * what a visitor actually said, because that is the part a prospect is
 * judging, and a built-in reply to a real answer is the one thing a demo
 * cannot fake.
 *
 * The exception is narrow in four ways at once, all of them checked in
 * `claimModelCall`: the run must be in candidate mode (observer mode is a
 * written script and never reaches here), the function must be one of the two
 * reactive ones, and both the sitting's and the day's allowances must have
 * room. The scaffolding — opening, transitions, close, sign-off — and all of
 * the scoring and the written report stay on the built-in writer regardless.
 *
 * Refusal is silent. The turn is written by the built-in writer and the
 * visitor is told nothing: there is nothing they could do about it, and an
 * interviewer that announced its own funding mid-interview would be the least
 * convincing thing in the demo.
 *
 * Imported lazily so this module stays free of the cycle it was split out to
 * avoid: the provider layer imports this file, and the run service imports the
 * database and the middleware that the provider layer sits under.
 */
export async function demoInterviewMaySpend(fn: string, sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false;
  const { claimModelCall } = await import('./demoInterviewRun.js');
  return claimModelCall(fn, sessionId);
}

/**
 * True when the interview belongs to a demo sandbox. The candidate side of an
 * interview runs on a link, not a session, so it is recognised by the
 * interview it is for rather than by who is signed in.
 */
export async function isHeuristicOnlySession(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false;
  const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { tenant: { select: { isDemo: true } } } });
  return session?.tenant.isDemo === true;
}

/**
 * True when a message from this organisation must not go to this address. A
 * demo sandbox may email only its own visitor: anyone could request a demo,
 * and without this it would send interview invitations to any address they
 * typed, from our domain. Ordinary organisations are never blocked.
 */
export async function demoRecipientBlocked(tenantId: string, to: string): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isDemo: true } });
  if (!tenant?.isDemo) return false;
  // The visitor's address lives on the grant; the demo login has its own.
  const address = to.trim().toLowerCase();
  const grant = await prisma.demoGrant.findFirst({ where: { tenantId, email: address }, select: { id: true } });
  if (grant) return false;
  // Sandboxes made before that change kept the address on the user.
  const visitor = await prisma.user.findFirst({ where: { tenantId, email: address }, select: { id: true } });
  return !visitor;
}

/**
 * Whether server speech (paid TTS/STT) may run for this interview. A demo
 * interview answers "no" and the client falls back to the browser's own voice
 * and recognition, which is what it already does when no server speech is
 * configured.
 */
export async function serverSpeechAllowed(sessionId: string, ready: () => boolean): Promise<boolean> {
  if (!ready()) return false;
  return !(await isHeuristicOnlySession(sessionId));
}
