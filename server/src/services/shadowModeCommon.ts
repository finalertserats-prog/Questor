// Shared vocabulary for shadow mode. A leaf module so the blind-review and
// agreement modules can both depend on it without importing each other or
// the shadowMode.ts entry point that re-exports them.

/** Terminal dispositions shared by the AI recommendation and the human verdict. */
export const DISPOSITIONS = ['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * HumanReview.status marker for a verdict recorded BEFORE the AI output was
 * revealed. The schema types `status` as a free string (documented as
 * PENDING | COMPLETED), so this extends the vocabulary without a migration.
 * Only rows carrying this marker are eligible for the agreement statistics —
 * a verdict filed through the normal review endpoint was made with the AI's
 * recommendation on screen and is therefore contaminated for this purpose.
 */
export const BLIND_REVIEW_STATUS = 'BLIND';

/**
 * The launch gate recorded in docs/BUILD_STATUS.md. It is quoted here, not
 * chosen here — this harness does not get to set its own passing grade.
 */
export const AGREEMENT_GATE = 0.75;

/**
 * Below this many paired observations the normal approximation used for the
 * kappa confidence interval is not trustworthy, so no conclusion is reported.
 * This is a conventional rule of thumb about the large-sample approximation —
 * it is NOT a power calculation and NOT a validated sample size for this tool.
 */
export const MINIMUM_N = 30;

/** Audit action recording that a reviewer opened an assessment without blinding. */
export const BLIND_BYPASS_ACTION = 'review.blind_bypassed';

export function isDisposition(value: string): value is Disposition {
  return (DISPOSITIONS as readonly string[]).includes(value);
}

/** Four-decimal rounding used for every reported statistic. */
export function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
