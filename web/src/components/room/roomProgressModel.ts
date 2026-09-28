/**
 * The top bar's sense of "how far through am I".
 *
 * Everything here is derived from what the room genuinely knows: the planned
 * length, the time elapsed, and the interviewer turns it has received. The
 * server does not say how many questions the plan holds or which section a
 * question belongs to, so the bar does not claim either — a made-up "Question
 * 3 of 8" that turns into "Question 11 of 8" is worse than no count at all.
 */

const MINUTE = 60_000;

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function timeLeftText(durationMinutes: number, elapsedMs: number): string {
  const remaining = durationMinutes * MINUTE - elapsedMs;
  if (remaining <= 0) return 'past the planned time';
  if (remaining < MINUTE) return 'less than a minute left';
  // Rounded up: "about 20" when 19:40 remain reads as the truth; "about 19"
  // would have the candidate hurrying for time they do have.
  return `about ${Math.ceil(remaining / MINUTE)} min left`;
}

export interface ProgressInput {
  readonly started: boolean;
  readonly durationMinutes: number;
  readonly elapsedMs: number;
  /** The current question's number, or null when it cannot be known honestly. */
  readonly question: number | null;
}

export function progressLabel(input: ProgressInput): string {
  if (!input.started) return `${input.durationMinutes} min interview`;
  const left = timeLeftText(input.durationMinutes, input.elapsedMs);
  return input.question === null ? left : `Question ${input.question} · ${left}`;
}

export type TrackSegment = 'done' | 'now' | 'ahead';

/** The segmented track, filled by time: the one progress measure the room actually has. */
export function timeTrack(elapsedMs: number, durationMinutes: number, segments = 8): TrackSegment[] {
  const span = (durationMinutes * MINUTE) / segments;
  return Array.from({ length: segments }, (_, i): TrackSegment => {
    if (elapsedMs <= 0 || span <= 0) return 'ahead';
    if (elapsedMs >= (i + 1) * span) return 'done';
    return elapsedMs >= i * span ? 'now' : 'ahead';
  });
}

interface CountedMessage {
  readonly speaker: 'agent' | 'candidate';
  /** A check-in after a long silence: said by the interviewer, but not a question. */
  readonly nudge?: boolean;
  /** The interviewer's last turn — the sign-off — which asks nothing. */
  readonly final?: boolean;
}

/**
 * Which question the candidate is on: every interviewer turn after the
 * opening counts, follow-ups included — each is something to answer. The
 * portal does not say which turns are follow-ups, and guessing from the text
 * would be less honest than this plain count.
 */
export function questionNumber(messages: readonly CountedMessage[]): number | null {
  const asked = messages.filter((m) => m.speaker === 'agent' && !m.nudge && !m.final).length - 1;
  return asked > 0 ? asked : null;
}
