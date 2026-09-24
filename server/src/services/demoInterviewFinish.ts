import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { finalizeInterview } from '../realtime/interviewEngine.js';
import { runAsDemo } from './demoPolicy.js';
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

  const session = await prisma.interviewSession.findUnique({ where: { id: run.sessionId }, select: { state: true } });
  if (!session) {
    // The sandbox went while the sitting was open. Nothing to finalise, and
    // nothing to be sorry about: the data is gone because it was meant to be.
    await endRun(run.id, 'demo_ended', now);
    return 'already_ended';
  }

  // THE BOX MAY HURRY THE SCRIPT. THE VISITOR MAY NOT.
  //
  // At the box the rest of the written conversation lands quickly, so a
  // watcher sees an interview that ended rather than one that was switched
  // off. But a visitor pressing End demo — or calling the finish route from a
  // console — must not be able to skip the pacing and read the whole
  // transcript and its assessment at once: the pace IS the mode.
  if (run.mode === 'observer' && reason === 'cap') {
    await playUpTo({ sessionId: run.sessionId, startedAt: run.startedAt, now, hurry: true, script: DEMO_OBSERVER_SCRIPT });
  }

  const walkedAway = run.mode === 'candidate' && reason === 'cap' && (await visitorHasGone(run.sessionId, now));

  // CLAIM THE SITTING BEFORE DOING ANYTHING SLOW TO IT.
  //
  // The sweep job, a second sweep on another instance and the visitor's own
  // finish request all reach this function for the same run. Finalising first
  // and recording afterwards let the loser of that race overwrite the winner's
  // outcome — a sitting that was assessed could end up filed as
  // `engine_unavailable` because the second caller's finalize threw on a
  // session the first had already moved on. `endRun` is a conditional update
  // on `endedAt IS NULL`, so exactly one caller proceeds.
  const claimed = await endRun(run.id, walkedAway ? 'abandoned' : reason, now);
  if (!claimed) return 'already_ended';

  if (walkedAway) {
    // An interruption is not a performance. The transcript is kept and nothing
    // is scored — the same answer the product gives a real candidate whose
    // network died, which is itself worth a prospect seeing.
    await noteStageForRun(run.id, 'interviewing');
    logger.info({ runId: run.id }, 'Demo interview abandoned part-way; transcript kept, nothing scored');
    return 'abandoned';
  }

  const state = (await prisma.interviewSession.findUnique({ where: { id: run.sessionId }, select: { state: true } }))?.state ?? session.state;
  if (!FINALIZABLE.has(state)) {
    // Past finalising is not the same as never finalised. A session already in
    // REVIEW_READY has the assessment this sitting promised, so the sitting is
    // assessed — reporting it as "could not be finalised" would file a demo
    // that worked as one that did not.
    return (await hasAssessment(run.sessionId)) ? finishAsAssessed(run.id) : 'not_finalizable';
  }

  try {
    // Finalised INSIDE the demo context, so `generateJson` answers null for
    // every call it makes whether or not that call passes a session id. The
    // tenant check alone was a reason to believe observer mode never reaches a
    // model; this makes it true by construction, for the sweep job and the
    // routes alike.
    await runAsDemo(() => finalizeInterview(run.sessionId));
    await noteStageForRun(run.id, 'assessed');
    return 'assessed';
  } catch (err) {
    // NOT EVERY THROW IS A FAILURE. `finalizeInterview` holds its own mutex on
    // the session, and it refuses a second caller — which can be an ordinary
    // finalisation from the portal or the socket, already producing exactly
    // the assessment we wanted. Filing that as our outage would put an
    // engine failure on a demo that worked. The assessment is the evidence,
    // so it is what gets looked at before anything is written down.
    if (await hasAssessment(run.sessionId)) return finishAsAssessed(run.id);
    logger.error({ err: err instanceof Error ? err.message : String(err), runId: run.id }, 'Could not finalise a demo interview');
    await prisma.demoInterviewRun.updateMany({ where: { id: run.id }, data: { endReason: 'engine_unavailable' } });
    return 'failed';
  }
}

async function hasAssessment(sessionId: string): Promise<boolean> {
  return (await prisma.assessmentVersion.count({ where: { sessionId } })) > 0;
}

async function finishAsAssessed(runId: string): Promise<DemoFinishOutcome> {
  await noteStageForRun(runId, 'assessed');
  return 'assessed';
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
 * Tidy up observer sittings whose script is already fully written but which
 * were never closed.
 *
 * DOES NOT PLAY ANYTHING. It used to, and that quietly contradicted the whole
 * lazy-playback design: a watcher who closed the tab left this job writing
 * their transcript out a minute at a time for nobody. Playback belongs to
 * whoever is watching (the watch route) and to the box (the sweep below).
 * What is left here is the narrow case where every line was written but the
 * response that should have finished the run never landed.
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
    const written = await prisma.turn.count({ where: { sessionId: run.sessionId } });
    if (written < DEMO_OBSERVER_SCRIPT.length) continue;
    if ((await finishDemoRun(run, 'completed', now)) === 'assessed') finished += 1;
  }
  return finished;
}
