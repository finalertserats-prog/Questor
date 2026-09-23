/**
 * "The transcript was read" — what it means, and what the server will accept as
 * evidence of it.
 *
 * The review page has always tracked how far the reviewer had scrolled, and
 * said so in a note beside the form. It said so honestly: the note was guidance
 * and nothing more, because a gate that lives only in the browser is not a
 * gate. This module is the other half — the definition the server holds the
 * reviewer to before it will record their verdict on the AI round.
 *
 * WHAT COUNTS AS READ
 *
 * Every turn of the conversation was put in front of the reviewer. Not a
 * scroll percentage: a percentage is a property of a scrollbar, and a reviewer
 * who reads with a screen reader, or with the keyboard, or on a page they never
 * scroll, would fail a test about scrollbars while having read every word.
 * Turns are countable, they are what the transcript IS, and every way of
 * reading reaches them.
 *
 * The client reports which turn indexes it showed. The server checks that
 * report against the turns the session actually has, so a client that has not
 * loaded the transcript cannot satisfy the gate by asserting it did, and a
 * transcript that grew between the reading and the verdict is caught.
 *
 * WHAT THIS IS NOT
 *
 * It is not proof that anybody's eyes moved, and this module does not pretend
 * otherwise. A determined reviewer can page to the bottom without reading a
 * word, exactly as they could before. What changes is that they must now
 * request the transcript, pass through it, and leave a record with their name
 * and the time on it — which is what "meaningful human review" is audited on.
 * The alternative to an attestable record is not a stronger gate; it is no
 * record at all.
 */

/** How the reviewer satisfied the requirement. Both are recorded; neither is a default. */
export const READ_METHODS = ['in_app', 'elsewhere'] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

/**
 * The shortest attestation the "I read it elsewhere" path accepts.
 *
 * Reviewers do download the transcript and read it in a document, and leaving
 * them no way to say so would leave them a dead end — from which the only exits
 * are pretending to scroll, or not reviewing at all. So the path exists, it is
 * explicit, and it costs a sentence saying where they read it, which is what
 * makes the audit record worth having.
 */
export const ATTESTATION_MIN = 20;
export const ATTESTATION_MAX = 500;

export interface ReadReport {
  readonly method: ReadMethod;
  /** Turn indexes the page showed the reviewer. Empty on the `elsewhere` path. */
  readonly seenIndexes: readonly number[];
  /** Where and how they read it. Required on the `elsewhere` path, empty otherwise. */
  readonly attestation: string;
}

/**
 * Turn indexes in `all` that the report does not cover, in order. Empty when
 * the whole transcript was seen — including when there is nothing to see.
 */
export function unseenIndexes(all: readonly number[], seen: readonly number[]): number[] {
  const reported = new Set(seen);
  return all.filter((index) => !reported.has(index));
}

export type ReadRefusal =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'incomplete'; readonly unseen: readonly number[]; readonly total: number }
  | { readonly ok: false; readonly reason: 'no_attestation' };

/**
 * Whether this report satisfies the requirement for a transcript with these
 * turn indexes.
 *
 * A transcript with no turns at all is not a loophole worth closing here: the
 * report is still required, still names the reviewer, and is still written to
 * the audit trail. What it is not is a reason to strand a reviewer in front of
 * an empty conversation with a button they cannot press.
 */
export function checkReadReport(report: ReadReport, allIndexes: readonly number[]): ReadRefusal {
  if (report.method === 'elsewhere') {
    // Both bounds here, not only at the route's schema. The rule is the thing
    // that decides whether a reviewer has met the requirement, and a rule that
    // relies on every future caller remembering a second check is one bug away
    // from storing whatever arrives.
    const length = report.attestation.trim().length;
    const written = length >= ATTESTATION_MIN && length <= ATTESTATION_MAX;
    return written ? { ok: true } : { ok: false, reason: 'no_attestation' };
  }
  const unseen = unseenIndexes(allIndexes, report.seenIndexes);
  return unseen.length === 0 ? { ok: true } : { ok: false, reason: 'incomplete', unseen, total: allIndexes.length };
}

export function readRefusalMessage(refusal: Extract<ReadRefusal, { ok: false }>): string {
  if (refusal.reason === 'no_attestation') {
    return `Say where you read the transcript — at least ${ATTESTATION_MIN} characters. This is recorded with your name against the review.`;
  }
  const read = refusal.total - refusal.unseen.length;
  return `The transcript has ${refusal.total} turns and ${read} of them have been shown. Read to the end of the conversation, or say that you read it elsewhere.`;
}

/** The error code the review endpoint refuses with, so the page can offer the transcript. */
export const TRANSCRIPT_NOT_READ = 'transcript_not_read';

export const TRANSCRIPT_NOT_READ_MESSAGE =
  'Read the transcript before recording your verdict. Open the conversation and read to the end, '
  + 'or record that you read it elsewhere — either way it is kept with your review.';
