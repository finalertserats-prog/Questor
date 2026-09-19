/**
 * How the interview room opens from a start response — fresh or resumed.
 * Kept free of React so it can be unit tested (see web/tests/roomResumeModel.test.ts).
 *
 * WHY: the room calls start on every entry, including a reload or a return
 * through the invitation link mid-interview. It used to treat every response
 * as the opening, so the interviewer read the AI disclosure aloud again and
 * re-asked a question already answered. The server now says when a start is a
 * resume and hands back the conversation so far; this decides what the room
 * does with that.
 */

export interface StartedTurn {
  readonly turnId: string;
  readonly text: string;
  readonly competencyId: string;
  readonly kind: string;
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
  readonly elapsedMs?: number;
}

/**
 * Said once on a rejoin, in the caption only — never spoken, never stored.
 * Identical every time on purpose: it is a signpost, not a line of the
 * interview, and varying it would read as the interviewer improvising.
 */
export const WELCOME_BACK = 'Welcome back.';

/** Shown instead when the candidate's last answer is on record but no reply to it is. */
export const ANSWER_SAVED = 'Welcome back. Your last answer was saved — add anything you would like, then send it to carry on.';

export interface RoomOpening {
  /**
   * 'speak': say `turn` and then listen, as after any agent turn.
   * 'listen': listen straight away without speaking — the question on screen
   * has already been answered, and asking it aloud again would tell the
   * candidate their answer was lost when it was not.
   */
  readonly mode: 'speak' | 'listen';
  readonly turn: StartedTurn;
  /** The transcript to show, oldest first. */
  readonly messages: TranscriptLine[];
  /** Caption text shown before the interviewer's line; empty on a fresh start. */
  readonly captionPrefix: string;
  /** How far the room's clock is set back so answer stamps keep counting up. */
  readonly clockOffsetMs: number;
}

export function roomOpening(res: StartResponse): RoomOpening {
  // An older server sends only the turn; the turn alone is then the whole
  // conversation, exactly as the room used to show it.
  const messages = res.history && res.history.length > 0
    ? res.history.map((line) => ({ speaker: line.speaker, text: line.text }))
    : [{ speaker: 'agent' as const, text: res.turn.text }];
  const resumed = res.resumed === true;
  // Answer timestamps are measured from the room's clock start. On a rejoin the
  // clock is set back by how far in the interview already is, so a new answer
  // is stamped after everything on record rather than from zero again.
  const clockOffsetMs = resumed && typeof res.elapsedMs === 'number' && Number.isFinite(res.elapsedMs)
    ? Math.max(0, res.elapsedMs)
    : 0;
  if (resumed && res.awaitingReply === true) {
    return { mode: 'listen', turn: res.turn, messages, captionPrefix: ANSWER_SAVED, clockOffsetMs };
  }
  return { mode: 'speak', turn: res.turn, messages, captionPrefix: resumed ? WELCOME_BACK : '', clockOffsetMs };
}
