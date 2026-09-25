import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { DEMO_OBSERVER_SCRIPT, scriptLineText, type DemoScriptLine } from '../domain/demoObserverScript.js';

/**
 * Playing the written interview at the pace a real one runs.
 *
 * NO TIMER DRIVES THIS. The first version held a setInterval per watcher,
 * which is three bugs waiting: a restart loses every sitting in flight, a
 * watcher who closes the tab leaves the loop writing turns nobody is reading,
 * and two server instances each play the same script into the same session.
 *
 * Instead every line has a reveal time computed from the sitting's start, and
 * turns are written lazily by whoever asks what has happened so far. That
 * makes the playback a pure function of the clock: idempotent, restart-proof,
 * identical whoever asks, and completely idle when nobody is watching.
 */

/** The name this sandbox's interviewer goes by, for the script's placeholders. */
async function interviewerName(sessionId: string): Promise<string> {
  const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { personaJson: true } });
  try {
    const persona = JSON.parse(session?.personaJson ?? '{}') as { name?: unknown };
    return typeof persona.name === 'string' && persona.name ? persona.name : 'your interviewer';
  } catch {
    return 'your interviewer';
  }
}

/** Cumulative reveal offsets, in the script's own order. */
export function revealOffsets(script: readonly DemoScriptLine[] = DEMO_OBSERVER_SCRIPT): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const line of script) {
    at += line.afterMs;
    offsets.push(at);
  }
  return offsets;
}

/**
 * How many lines have been said by now.
 *
 * `hurry` collapses the remaining pauses — used when the time box has arrived
 * and the sitting has to be finished. The watcher sees the rest of the
 * conversation land quickly rather than a transcript that stops mid-answer.
 */
export function revealedCount(elapsedMs: number, script: readonly DemoScriptLine[] = DEMO_OBSERVER_SCRIPT): number {
  const offsets = revealOffsets(script);
  let count = 0;
  while (count < offsets.length && offsets[count] <= elapsedMs) count += 1;
  return count;
}

export function scriptComplete(elapsedMs: number, script: readonly DemoScriptLine[] = DEMO_OBSERVER_SCRIPT): boolean {
  return revealedCount(elapsedMs, script) >= script.length;
}

/** The moment the whole script has played out, for a sitting that began then. */
export function playedOutAt(startedAt: Date, script: readonly DemoScriptLine[] = DEMO_OBSERVER_SCRIPT): Date {
  const offsets = revealOffsets(script);
  return new Date(startedAt.getTime() + (offsets[offsets.length - 1] ?? 0));
}

/**
 * Write every line that should have been said by now, and report the state.
 *
 * Safe to call from anything, as often as anything likes: turn indexes are
 * unique per session, so a line another caller has already written is skipped
 * rather than duplicated. That is what lets the watcher's poll, the sweep job
 * and a second tab all drive the same sitting without coordinating.
 */
export async function playUpTo(opts: {
  sessionId: string;
  startedAt: Date;
  now?: Date;
  /** Write the whole remaining script regardless of the clock. */
  hurry?: boolean;
  script?: readonly DemoScriptLine[];
}): Promise<{ written: number; revealed: number; complete: boolean }> {
  const script = opts.script ?? DEMO_OBSERVER_SCRIPT;
  const now = opts.now ?? new Date();
  const elapsed = now.getTime() - opts.startedAt.getTime();
  const revealed = opts.hurry ? script.length : revealedCount(elapsed, script);

  // The interviewer is whoever this sandbox was given, so the opening greets
  // the candidate with the same name the participants rail shows.
  const interviewer = await interviewerName(opts.sessionId);
  const existing = await prisma.turn.count({ where: { sessionId: opts.sessionId } });
  let written = 0;
  for (let index = existing; index < revealed; index += 1) {
    const line = script[index];
    // The transcript's timings are the script's, not the wall clock's: an
    // interview hurried to its close at the time box must still read as the
    // conversation it was written to be, and `elapsedMinutes` is derived from
    // these stamps.
    const startMs = index === 0 ? 0 : revealOffsets(script)[index - 1];
    const endMs = revealOffsets(script)[index];
    try {
      await prisma.turn.create({
        data: {
          sessionId: opts.sessionId,
          index,
          speaker: line.speaker,
          text: scriptLineText(line, interviewer),
          startMs,
          endMs,
          confidence: 1,
          competencyId: line.competencyId ?? '',
          metaJson: JSON.stringify({
            ...(line.kind ? { kind: line.kind } : {}),
            // Every turn says, on the record, that it was played from a script.
            // A transcript a prospect can download must never be mistakable for
            // a conversation somebody actually had.
            simulated: true,
          }),
        },
      });
      written += 1;
    } catch (err) {
      // P2002 on (sessionId, index): another caller wrote this line first,
      // which is the ordinary case when two tabs are open.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), index }, 'Could not play a demo script line');
        break;
      }
    }
  }
  const total = await prisma.turn.count({ where: { sessionId: opts.sessionId } });
  return { written, revealed, complete: total >= script.length };
}
