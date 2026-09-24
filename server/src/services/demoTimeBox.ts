import { movingToCloseLine, mustStopAsking, signalClosedForTimeBox, staysInCharacter } from '../domain/demoInterview.js';
import { logger } from '../logger.js';
import { runForSession } from './demoInterviewRun.js';
import type { DirectorSignal } from '../domain/types.js';

/**
 * The fifteen-minute box, as the interview engine meets it.
 *
 * ONE call, made where the engine has just decided what to say next and has
 * not yet said it. That placement is the whole design:
 *
 *   - It is a TURN BOUNDARY. The box can therefore never truncate anything.
 *     A visitor still typing at minute fourteen has their answer taken in
 *     full; what changes is that the interviewer's reply is a close rather
 *     than another question.
 *   - It reuses the director's own close. `directorDecide` already returns
 *     exactly this signal when it runs out of planned time, and the
 *     conversation engine already knows how to speak it — so the box produces
 *     the interviewer's ordinary closing turn, whole, rather than a stub.
 *   - The only thing added is one sentence in the interviewer's voice, saying
 *     that a demo is kept short. That is the entire visible effect of every
 *     bound the demo has: the clock, the spend ceiling and a provider that has
 *     stopped answering all arrive here and all sound the same.
 *
 * A demo interview is the one place in this product where the words "limit",
 * "quota" and "unavailable" must never appear, so the sentence is checked
 * against that list before it is used rather than trusted.
 */

export interface DemoTurnShaping {
  readonly signal: DirectorSignal;
  /** Prepended to whatever the engine writes, or empty. */
  readonly prefix: string;
}

/**
 * Shape the next turn for a demo interview past its time box.
 *
 * Returns the signal unchanged for every interview that is not a demo, which
 * is almost all of them: one indexed lookup on a session id.
 */
export async function shapeDemoTurn(sessionId: string, signal: DirectorSignal, now = new Date()): Promise<DemoTurnShaping> {
  const run = await runForSession(sessionId);
  if (!run || !mustStopAsking(now, run)) return { signal, prefix: '' };

  // Already closing of its own accord: the box has nothing to add, and saying
  // "let me bring us to a close" over the interviewer's own close would read
  // as a stumble.
  if (signal.action === 'close') return { signal, prefix: '' };

  const line = movingToCloseLine();
  if (!staysInCharacter(line)) {
    // Refusing to say it is better than saying it: the engine's own close is
    // already in character, and this only ever fires if somebody edits the
    // line into something that names our machinery.
    logger.error({ line }, 'The demo close line names system machinery; saying the interviewer\'s own close instead');
    return { signal: signalClosedForTimeBox(signal), prefix: '' };
  }
  return { signal: signalClosedForTimeBox(signal), prefix: line };
}

/** Join the demo's transition to the engine's own words, as one utterance. */
export function withPrefix(prefix: string, text: string): string {
  return prefix ? `${prefix} ${text}`.trim() : text;
}
