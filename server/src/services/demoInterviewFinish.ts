import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { finalizeInterview } from '../realtime/interviewEngine.js';
import { mustFinalise } from '../domain/demoInterview.js';
import { DEMO_OBSERVER_SCRIPT } from '../domain/demoObserverScript.js';
import { playUpTo } from './demoObserverPlayer.js';
import { endRun, noteStageForRun, runById, type DemoRunRow } from './demoInterviewRun.js';

/**
 * Ending a demo interview: at the box, when the script runs out, when the
 * visitor presses End demo, and when they simply close the tab.
 *
 * All four arrive here so there is one answer to "what happens to the
 * transcript", rather than four that disagree.
 */

/**
 * Quiet time after a visitor's last answer before their sitting is treated as
 * abandoned rather than merely slow.
 *
 * Three minutes, not thirty seconds: somebody composing an answer with a
 * switch device or a screen reader is not gone, and the cost of guessing wrong
 * is that their interview is filed as abandoned while they are still typing.
 */
export const DEMO_IDLE_MS = 3 * 60_000;

/** States from which `finalizeInterview` will produce an assessment. */
const FINALIZABLE = new Set(['ASSESSING', 'CANDIDATE_QUESTIONS', 'CLOSING', 'PROCESSING']);

export type DemoFinishOutcome = 'assessed' | 'abandoned' | 'already_ended' | 'not_finalizable' | 'failed';

/**
 * Bring one sitting to its end.
 *
 * WHETHER IT IS SCORED IS THE ONE REAL DECISION HERE, and it follows the rule
 * the rest of the product already follows: an interruption is not a
 * performance. A visitor who closed the tab part-way gets a transcript and no
 * assessment, exactly as a real candidate whose network died does — which is
 * itself worth a prospect seeing, because it is the product's answer to a
 * question every hiring team asks.
 *
 * A visitor who was still answering when the fifteen minutes ran out is not
 * interrupted: they are closed and scored, because being closed at the box is
 * the demo working, not the demo breaking.
 */
export async function finishDemoRun(run: DemoRunRow, reason: 'cap' | 'demo_ended' | 'completed', now = new Date()): Promise<DemoFinishOutcome> {
  if (run.endedAt) return 'already_ended';

  const session = await prisma.interviewSession.findUnique({
    where: { id: run.sessionId },
    select: { state: true },
  });
  if (!session) {
    // The sandbox went while the sitting was open. Nothing to finalise, and
    // nothing to be sorry about: the data is gone because it was meant to be.
    await endRun(run.id, 'demo_ended', now);
    return 'already_ended';
  }

  if (run.mode === 'observer') {
    // The rest of the written conversation lands quickly rather than the
    // transcript stopping mid-answer. A watcher must see an interview that
    // ended, not one that was switched off.
    await playUpTo({ sessionId: run.sessionId, startedAt: run.startedAt, now, hurry: true, script: DEMO_OBSERVER_SCRIPT });
  } else if (reason === 'cap' && (await visitorHasGone(run.sessionId, now))) {
    await endRun(run.id, 'abandoned', now);
    await noteStageForRun(run.id, 'interviewing');
    logger.info({ runId: run.id }, 'Demo interview abandoned part-way; transcript kept, nothing scored');
    return 'abandoned';
  }

  const state = (await prisma.interviewSession.findUnique({ where: { id: run.sessionId }, select: { state: true } }))?.state ?? session.state;
  if (!FINALIZABLE.has(state)) {
    await endRun(run.id, reason, now);
    return 'not_finalizable';
  }

  try {
    await finalizeInterview(run.sessionId);
    await endRun(run.id, reason === 'cap' ? 'cap' : reason, now);
    await noteStageForRun(run.id, 'assessed');
    return 'assessed';
  } catch (err) {
    // The interviewer's own failure, not the visitor's. Recorded as ours so
    // the owner's console does not read it as a prospect who gave up.
    logger.error({ err: err instanceof Error ? err.message : String(err), runId: run.id }, 'Could not finalise a demo interview');
    await endRun(run.id, 'engine_unavailable', now);
    return 'failed';
  }
}

/** Nobody has answered for long enough that the tab is probably closed. */
async function visitorHasGone(sessionId: string, now: Date): Promise<boolean> {
  const last = await prisma.turn.findFirst({
    where: { sessionId, speaker: 'candidate' },
    orderBy: { index: 'desc' },
    select: { createdAt: true },
  });
  if (!last) return true;
  return now.getTime() - last.createdAt.getTime() > DEMO_IDLE_MS;
}

/**
 * One sweep. Closes every sitting that has reached its box, whoever is or is
 * not still watching.
 *
 * This is the half of the cap a request cannot enforce: a visitor who closes
 * the tab at minute two makes no further requests, so nothing else would ever
 * look at their sitting again.
 */
export async function sweepDemoInterviews(now = new Date()): Promise<{ swept: number; assessed: number; abandoned: number }> {
  const open = await prisma.demoInterviewRun.findMany({
    where: { endedAt: null, capAt: { lte: now } },
    select: { id: true },
  });
  let assessed = 0;
  let abandoned = 0;
  for (const { id } of open) {
    const run = await runById(id);
    if (!run || !mustFinalise(now, run)) continue;
    const outcome = await finishDemoRun(run, 'cap', now);
    if (outcome === 'assessed') assessed += 1;
    if (outcome === 'abandoned') abandoned += 1;
  }
  return { swept: open.length, assessed, abandoned };
}

/**
 * Observer sittings whose script has played out are finished without waiting
 * for the box: the watcher should see the interview end when the interview
 * ends.
 */
export async function finishPlayedOutObserverRuns(now = new Date()): Promise<number> {
  const open = await prisma.demoInterviewRun.findMany({
    where: { endedAt: null, mode: 'observer' },
    select: { id: true },
  });
  let finished = 0;
  for (const { id } of open) {
    const run = await runById(id);
    if (!run) continue;
    const played = await playUpTo({ sessionId: run.sessionId, startedAt: run.startedAt, now });
    if (!played.complete) continue;
    if ((await finishDemoRun(run, 'completed', now)) === 'assessed') finished += 1;
  }
  return finished;
}
