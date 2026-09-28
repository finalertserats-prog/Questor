/**
 * Which turns of the transcript the reviewer has actually been shown, and how
 * the page tells the server so.
 *
 * The older reading here (`readFraction` in transcriptReaderModel) measures how
 * far the transcript has scrolled past the viewport. That is still the right
 * thing for the label beside the form — it answers "how far down am I?" — but
 * it cannot be the gate, for two reasons.
 *
 * It is not reachable by everyone. A scroll fraction is a fact about a
 * scrollbar. A reviewer using a screen reader never moves one: their software
 * reads the rendered list from top to bottom and they reach the end having read
 * every word, with the scroll position untouched. A keyboard user moves focus
 * rather than scrolling. Gating on scroll would fail both of them for doing the
 * thing the gate is asking for.
 *
 * And it is not checkable. A percentage means nothing to a server, which has no
 * viewport; it would have to take the number on trust. Turn indexes it can
 * check against the interview that exists.
 *
 * So the page tracks turns. A turn counts as shown when it enters the viewport
 * OR when it takes focus — which covers scrolling, tabbing and arrowing alike.
 * And reaching the end of the transcript counts everything above it: the list
 * is rendered whole, never virtualised, so a reader at the bottom has had all
 * of it delivered. That last rule is what makes the gate satisfiable by someone
 * whose assistive technology reads straight through without ever firing a
 * scroll event.
 */

export interface SeenTurns {
  /** The transcript these marks belong to; a different one starts again. */
  readonly key: string;
  readonly seen: ReadonlySet<number>;
  /** The end-of-transcript marker has been reached, by scroll or by focus. */
  readonly endReached: boolean;
}

export function noTurnsSeen(key: string): SeenTurns {
  return { key, seen: new Set(), endReached: false };
}

/** A new object every time: the caller holds this in state and must see it change. */
export function markTurnSeen(state: SeenTurns, index: number): SeenTurns {
  if (state.seen.has(index)) return state;
  return { ...state, seen: new Set(state.seen).add(index) };
}

export function markEndReached(state: SeenTurns): SeenTurns {
  return state.endReached ? state : { ...state, endReached: true };
}

/** Start again when the page moves to a different transcript. */
export function forTranscript(state: SeenTurns, key: string): SeenTurns {
  return state.key === key ? state : noTurnsSeen(key);
}

/**
 * The indexes to report to the server. Reaching the end reports the whole
 * transcript, because everything above the end was rendered to get there.
 */
export function reportableIndexes(state: SeenTurns, allIndexes: readonly number[]): number[] {
  if (state.endReached) return [...allIndexes];
  return allIndexes.filter((index) => state.seen.has(index));
}

export function hasReadAll(state: SeenTurns, allIndexes: readonly number[]): boolean {
  return reportableIndexes(state, allIndexes).length === allIndexes.length;
}

/** How far through, for a label. Kept separate from the gate so neither drifts. */
export function turnsReadLabel(state: SeenTurns, allIndexes: readonly number[]): string {
  const read = reportableIndexes(state, allIndexes).length;
  return read >= allIndexes.length ? 'Transcript read' : `Read ${read} of ${allIndexes.length} turns`;
}

// ---------------------------------------------------------------------------
// What the server keeps, and what it refuses with
// ---------------------------------------------------------------------------

export type ReadMethod = 'in_app' | 'elsewhere';

export interface TranscriptReadRecord {
  readonly method: ReadMethod;
  readonly turnsSeen: number;
  readonly turnsTotal: number;
  readonly at: string;
}

/** The code POST /assessments/:id/review refuses a verdict with. */
export const TRANSCRIPT_NOT_READ = 'transcript_not_read';
/** The code the decision, finalise and export endpoints refuse with. */
export const HUMAN_REVIEW_REQUIRED = 'human_review_required';

export const ATTESTATION_MIN = 20;
export const ATTESTATION_MAX = 500;

export function attestationIsEnough(text: string): boolean {
  return text.trim().length >= ATTESTATION_MIN;
}

export const ATTESTATION_PROMPT =
  'Say where you read the transcript. This is kept with your review, with your name and the time on it.';

export function readRecordSentence(record: TranscriptReadRecord | null): string {
  if (!record) return 'Read the transcript before recording your verdict.';
  return record.method === 'elsewhere'
    ? 'You recorded that you read this transcript elsewhere.'
    : `You have read this transcript (${record.turnsSeen} of ${record.turnsTotal} turns).`;
}

export function isTranscriptNotReadError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === TRANSCRIPT_NOT_READ;
}
