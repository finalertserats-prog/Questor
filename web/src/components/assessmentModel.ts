/**
 * What a reviewer may record against an assessment, and when. Kept free of
 * React so it can be unit tested (see web/tests/assessmentModel.test.ts).
 */

import { hasScore } from './scoreFormat';

/** The verdicts a person can record. Ordered as the form offers them. */
export const DISPOSITIONS = ['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS'] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * What the server reports when the grading provider was unreachable: the
 * interview happened, the evidence exists, and there is no score. It is a
 * state of the grading, never a verdict on the candidate — which is why it is
 * not a Disposition and cannot be chosen in the review form.
 */
export const SCORING_UNAVAILABLE = 'SCORING_UNAVAILABLE';

export function isDisposition(value: unknown): value is Disposition {
  return typeof value === 'string' && (DISPOSITIONS as readonly string[]).includes(value);
}

/** Did grading produce a score? Zero is a score; null and NaN are not. */
export function isScored(result: { overallScore?: unknown } | null | undefined): boolean {
  return hasScore(result?.overallScore);
}

/**
 * The ATS export result, as a sentence rather than the raw token.
 *
 * "Export status: QUEUED" asks the reader to know what the server's vocabulary
 * means. An unrecognised status is still shown — a token nobody planned for is
 * information — but the known ones say what actually happened.
 */
const EXPORT_SENTENCES: Readonly<Record<string, string>> = {
  QUEUED: 'Queued for export to your ATS.',
  SENT: 'Sent to your ATS.',
  DELIVERED: 'Delivered to your ATS.',
  SKIPPED: 'Not exported: no ATS is configured for this tenant.',
  FAILED: 'The export did not go through. Try again, or check the ATS connector in Admin.',
};

export function exportStatusSentence(status: string): string {
  return EXPORT_SENTENCES[status.trim().toUpperCase()] ?? `Export status: ${status}`;
}

/** The shortest reason that says anything; the server enforces the same floor. */
const MIN_REASON = 3;

export interface VerdictDraft {
  readonly disposition: string;
  readonly reason: string;
  readonly scored: boolean;
  readonly submitting: boolean;
}

/**
 * May this verdict be submitted?
 *
 * WHY "a verdict nobody chose" is its own case: the form used to default to
 * CONSIDER — including when the assessment had failed to load — so a reviewer
 * who typed a reason and pressed the button recorded a judgement they had
 * never made. An unanswered question stays unanswered.
 */
export function canSubmitVerdict({ disposition, reason, scored, submitting }: VerdictDraft): boolean {
  if (submitting || !scored) return false;
  if (!isDisposition(disposition)) return false;
  return reason.trim().length >= MIN_REASON;
}
