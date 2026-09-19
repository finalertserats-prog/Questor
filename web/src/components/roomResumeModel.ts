/**
 * How the interview room opens from a start response — fresh or resumed — and
 * how it reads a refused answer. Kept free of React so it can be unit tested
 * (see web/tests/roomResumeModel.test.ts).
 *
 * WHY: the room calls start on every entry, including a reload or a return
 * through the invitation link mid-interview. It used to treat every response
 * as the opening, so the interviewer read the AI disclosure aloud again and
 * re-asked a question already answered. The server now says when a start is a
 * resume and hands back the conversation so far; this decides what the room
 * does with that.
 */

import { entryFromRefusal } from './portalEntryModel';

export interface StartedTurn {
  readonly turnId: string;
  readonly text: string;
  readonly done: boolean;
}

export interface TranscriptLine {
  readonly speaker: 'agent' | 'candidate';
  readonly text: string;
}

/** POST /api/portal/:token/start. Every field but `turn` is absent on an older server. */
export interface StartResponse {
  readonly turn: StartedTurn;
  readonly resumed?: boolean;
  readonly history?: readonly TranscriptLine[];
  readonly awaitingReply?: boolean;
  readonly pendingAnswerAgeMs?: number;
  readonly elapsedMs?: number;
}

/**
 * Said once on a rejoin, in the caption only — never spoken, never stored.
 * Identical every time on purpose: it is a signpost, not a line of the
 * interview, and varying it would read as the interviewer improvising.
 */
export const WELCOME_BACK = 'Welcome back.';

/** Shown while the reply to an answer sent just before the rejoin is still on its way. */
export const PICKING_UP = 'Picking up where we left off…';

/** Shown when the last answer is on record but no reply to it is, and waiting is over. */
export const ANSWER_SAVED = 'Welcome back. Your last answer was saved — add anything you would like, or press Continue.';

/**
 * An answer younger than this probably still has its reply being produced by
 * the request that stored it (a reply can take a model call or two), so the
 * room waits for that reply instead of inviting the candidate to talk over it.
 */
export const REPLY_WAIT_WINDOW_MS = 60_000;
/** How often, and for how long in total, the room re-reads while waiting. */
export const REPLY_POLL_INTERVAL_MS = 2_000;
export const REPLY_POLL_BUDGET_MS = 45_000;

/** Mirrors the server's cap (interviewEngine resumeClockMs): past it, a stamp is not a measurement. */
export const MAX_CLOCK_OFFSET_MS = 6 * 60 * 60 * 1000;

export interface RoomOpening {
  /**
   * 'speak': say `turn` and then listen, as after any agent turn.
   * 'wait': the reply to the candidate's last answer is probably still being
   *   produced; show that, and re-read shortly (REPLY_POLL_*).
   * 'listen': listen straight away without speaking — the question on screen
   *   has already been answered, and asking it aloud again would tell the
   *   candidate their answer was lost when it was not. Continue is offered.
   */
  readonly mode: 'speak' | 'wait' | 'listen';
  readonly turn: StartedTurn;
  /** The transcript to show, oldest first. */
  readonly messages: TranscriptLine[];
  /** Caption text shown before the interviewer's line; empty on a fresh start. */
  readonly captionPrefix: string;
  /** How far the room's clock is set back so answer stamps keep counting up. */
  readonly clockOffsetMs: number;
}

export function roomOpening(res: StartResponse, opts: { readonly allowWait?: boolean } = {}): RoomOpening {
  // An older server sends only the turn; the turn alone is then the whole
  // conversation, exactly as the room used to show it.
  const messages = res.history && res.history.length > 0
    ? res.history.map((line) => ({ speaker: line.speaker, text: line.text }))
    : [{ speaker: 'agent' as const, text: res.turn.text }];
  const resumed = res.resumed === true;
  // Answer timestamps are measured from the room's clock start. On a rejoin the
  // clock is set back to where the record leaves off, so a new answer is
  // stamped after everything on record rather than from zero again.
  const clockOffsetMs = resumed && typeof res.elapsedMs === 'number' && Number.isFinite(res.elapsedMs)
    ? Math.min(Math.max(0, res.elapsedMs), MAX_CLOCK_OFFSET_MS)
    : 0;
  const base = { turn: res.turn, messages, clockOffsetMs };
  if (resumed && res.awaitingReply === true) {
    const recent = typeof res.pendingAnswerAgeMs === 'number' && res.pendingAnswerAgeMs < REPLY_WAIT_WINDOW_MS;
    if (recent && opts.allowWait !== false) return { ...base, mode: 'wait', captionPrefix: PICKING_UP };
    return { ...base, mode: 'listen', captionPrefix: ANSWER_SAVED };
  }
  return { ...base, mode: 'speak', captionPrefix: resumed ? WELCOME_BACK : '' };
}

/** Whether a re-read while waiting still has time left. */
export function keepWaitingForReply(waitedMs: number): boolean {
  return waitedMs < REPLY_POLL_BUDGET_MS;
}

/**
 * What a refused start, answer or Continue means for the room.
 *
 * 'finished' — the interview was completed (from another tab, or the reply
 *   the candidate missed was the sign-off); the link is spent, and retrying
 *   would loop on the same refusal. The room shows the done screen.
 * 'stale' — the interview moved past the question on screen; re-read it and
 *   put the current question, keeping what the candidate wrote.
 * 'error' — anything else, shown as the error it is.
 */
export type RoomRefusal = 'finished' | 'stale' | 'error';

export function roomRefusal(status: number | undefined, code: string | undefined, message: string): RoomRefusal {
  if (entryFromRefusal(status, message)?.kind === 'finished') return 'finished';
  if (status === 409 && code === 'stale_question') return 'stale';
  return 'error';
}
