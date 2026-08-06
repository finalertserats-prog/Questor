import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { setState, fmt } from '../realtime/interviewEngine.js';

/**
 * Close out interviews that stopped part-way, so they stop reading as live.
 *
 * Without this a session sits in ASSESSING for ever. Two real candidates spent
 * an evening displayed as "in progress" long after they had closed the tab,
 * nothing told anyone to chase them, and their transcripts never became
 * anything a reviewer could open.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO IS SCORE THEM.
 *
 * The first version of this file finalised any interview with three or more
 * substantial answers, which would have run the evaluator and written a
 * recommendation. That is the same defect this codebase has now fixed twice:
 * a candidate who answered well and then lost their network would receive a
 * permanent scored record from an interview they never chose to end, and a
 * word-count heuristic would have decided who was "complete enough" to judge —
 * penalising concise answers, second-language speakers, and anyone using an
 * assistive device.
 *
 * An interruption is not a performance. The transcript is preserved and made
 * readable; whether it is worth assessing is a human's call, made deliberately
 * via POST /interviews/:id/assess-partial, not a timer's.
 */

/** Quiet time after the last turn before an interview is treated as interrupted. */
export const INACTIVITY_MS = Number(process.env.INCOMPLETE_AFTER_MINUTES ?? 60) * 60_000;

const LIVE_STATES = ['DISCLOSURE', 'CONSENTED', 'WARMUP', 'ASSESSING', 'CANDIDATE_QUESTIONS'];

export interface SweepOutcome {
  sessionId: string;
  candidate: string;
  candidateAnswers: number;
  transcriptSaved: boolean;
}

/**
 * One pass. Safe to call repeatedly; sessions that have moved on are skipped.
 *
 * Makes no network calls of any kind — no evaluator, no LLM, no vendor. A
 * backlog of interrupted sessions therefore cannot produce a surprise bill or a
 * burst of concurrent provider requests, and there is no half-finished
 * finalisation to recover from if it fails midway.
 */
export async function sweepIncompleteInterviews(now = new Date()): Promise<SweepOutcome[]> {
  const cutoff = new Date(now.getTime() - INACTIVITY_MS);
  const outcomes: SweepOutcome[] = [];

  const sessions = await prisma.interviewSession.findMany({
    where: { state: { in: LIVE_STATES } },
    include: { candidate: { select: { fullName: true } }, role: { select: { title: true } } },
  });

  for (const session of sessions) {
    // Only the candidate's own turns count as activity. An interviewer check-in
    // spoken into a silence would otherwise keep resetting the clock on a
    // session nobody is sitting at.
    const lastCandidateTurn = await prisma.turn.findFirst({
      where: { sessionId: session.id, speaker: 'candidate' },
      orderBy: { index: 'desc' },
      select: { createdAt: true },
    });

    // A candidate who never got a word in still needs closing out, and an
    // earlier version of this skipped them entirely — which stranded exactly
    // the person our own bug had harmed: he reached the disclosure, the "Done
    // answering" button did nothing, and he was left in ASSESSING for ever with
    // no transcript because he had "not spoken".
    //
    // Reaching a live state means the interview was opened and started, so
    // `startedAt` is a sound fallback clock. An unopened invitation is still
    // untouched here, because INVITED and PROVISIONED are not live states.
    const lastActivity = lastCandidateTurn?.createdAt ?? session.startedAt;
    if (!lastActivity) continue;
    if (lastActivity > cutoff) continue;

    try {
      const turns = await prisma.turn.findMany({
        where: { sessionId: session.id },
        orderBy: { index: 'asc' },
      });

      // Re-read the state immediately before writing. The candidate may have
      // come back and answered between the query above and this line, and a
      // stale transition would close an interview out from under someone who is
      // mid-sentence.
      const fresh = await prisma.interviewSession.findUnique({
        where: { id: session.id }, select: { state: true },
      });
      if (!fresh || !LIVE_STATES.includes(fresh.state)) continue;

      const newest = await prisma.turn.findFirst({
        where: { sessionId: session.id, speaker: 'candidate' },
        orderBy: { index: 'desc' }, select: { createdAt: true },
      });
      const freshActivity = newest?.createdAt ?? session.startedAt;
      if (!freshActivity || freshActivity > cutoff) continue;

      // The transcript is the whole point: something a reviewer can open, and
      // something the candidate could be shown if they query what happened.
      const transcript = turns
        .map((t) => `[${fmt(t.startMs)}] ${t.speaker.toUpperCase()}: ${t.text}`)
        .join('\n');
      const already = await prisma.artifact.findFirst({
        where: { sessionId: session.id, kind: 'transcript' },
      });
      if (!already) {
        await prisma.artifact.create({
          data: {
            tenantId: session.tenantId, sessionId: session.id, candidateId: session.candidateId,
            kind: 'transcript', filename: `${session.id}-transcript.txt`,
            contentType: 'text/plain', storageKey: transcript,
            sizeBytes: transcript.length, retentionDays: 180,
          },
        });
      }

      await setState(session.id, fresh.state, 'INCOMPLETE');

      // NOT completedAt. Nothing was completed, and a downstream report that
      // counts completed interviews must not count this one.
      await prisma.interviewSession.update({
        where: { id: session.id },
        data: { interruptedAt: now },
      });

      const answers = turns.filter((t) => t.speaker === 'candidate').length;
      outcomes.push({
        sessionId: session.id, candidate: session.candidate.fullName,
        candidateAnswers: answers, transcriptSaved: true,
      });
      logger.info(
        { sessionId: session.id, answers, role: session.role.title },
        'Interview marked INCOMPLETE — transcript saved, deliberately not scored',
      );
    } catch (err) {
      // One bad session must not stop the rest being closed out.
      logger.error(
        { err: err instanceof Error ? err.message : String(err), sessionId: session.id },
        'Could not close out interrupted interview',
      );
    }
  }

  return outcomes;
}

/**
 * Run the sweep on a timer.
 *
 * Overlap-guarded: the sweep does no network I/O so a pass is short, but a slow
 * database must not let a second pass start on top of the first and race it to
 * the same rows.
 */
export function startIncompleteSweep(intervalMs = 5 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepIncompleteInterviews();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Incomplete sweep failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
