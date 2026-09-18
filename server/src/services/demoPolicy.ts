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

export function inDemoContext(): boolean {
  return demoContext.getStore()?.heuristicOnly === true;
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
  const visitor = await prisma.user.findFirst({ where: { tenantId, email: to.trim().toLowerCase() }, select: { id: true } });
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
