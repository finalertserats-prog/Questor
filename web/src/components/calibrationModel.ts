/**
 * The Calibration tab's reading of what the server sends, kept free of React
 * so the wording and the grouping are tested on their own
 * (web/tests/calibrationModel.test.ts).
 *
 * The rule the whole screen is built around: an admin must be able to answer
 * "why did a score move?" without leaving this page, and "nothing is applied"
 * must read as an answer rather than as an empty table.
 */

export type AdjustmentStatus = 'active' | 'held' | 'reverted';

export interface ReasonTheme {
  readonly label: string;
  readonly count: number;
  readonly aboutStrongAnswers: boolean;
}

export interface Adjustment {
  readonly id: string;
  readonly scope: string;
  readonly roleId: string;
  readonly competencyId: string;
  /** As the scorecard spells it. Falls back to the key when the role is gone. */
  readonly competencyName: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly status: string;
  readonly delta: number;
  readonly measuredMedian: number;
  readonly interval: { readonly low: number; readonly high: number } | null;
  readonly observations: number;
  readonly reviewers: number;
  readonly majorDisagreements: number;
  readonly since: string | null;
  readonly statement: string;
  readonly holdReason: string;
  readonly themes: readonly ReasonTheme[];
  readonly activatedAt: string | null;
  readonly revertedAt: string | null;
  readonly revertReason: string;
  readonly computedAt: string;
}

export interface AnchorProposal {
  readonly id: string;
  readonly roleId: string;
  readonly competencyId: string;
  readonly competencyName: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly status: string;
  readonly anchors: readonly string[];
  readonly themes: readonly ReasonTheme[];
  readonly observations: number;
  readonly reviewers: number;
  readonly createdAt: string;
}

export interface CalibrationSettings {
  readonly enabled: boolean;
  readonly platformEnabled: boolean;
  readonly organisationEnabled: boolean;
  readonly contributesGlobally: boolean;
  readonly thresholds: {
    readonly minObservations: number;
    readonly minReviewers: number;
    readonly maxAbsDelta: number;
    readonly reviewerPatternMinReviews: number;
  };
}

export interface CalibrationResponse {
  readonly settings: CalibrationSettings;
  readonly consentText: readonly string[];
  readonly adjustments: readonly Adjustment[];
  readonly proposals: readonly AnchorProposal[];
}

/**
 * What to call a competency on screen.
 *
 * The server sends the scorecard's own spelling, which is the only one that
 * gets acronyms right — "SQL and data modelling", not "Sql and data
 * modelling". The key is a lower-cased grouping key and is the last resort.
 */
export function competencyLabel(adjustment: { competencyName?: string; competencyKey: string }): string {
  const name = (adjustment.competencyName ?? '').trim();
  if (name) return name;
  const key = adjustment.competencyKey.trim();
  if (!key) return 'An unnamed competency';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function bandLabel(band: string): string {
  return band ? band : 'Any experience level';
}

/** "-0.5" reads better than "-0.5 levels" in a column of numbers. */
export function deltaLabel(delta: number): string {
  if (delta === 0) return 'No change';
  return signedLabel(delta);
}

/**
 * The same number as a bare signed figure.
 *
 * `deltaLabel` says "No change" for zero, which is right for the headline
 * figure and wrong inside "measured {x}, interval {a} to {b}" — that read
 * "measured No change", which is not a sentence.
 */
export function signedLabel(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

export function intervalLabel(adjustment: Pick<Adjustment, 'interval'>): string {
  if (!adjustment.interval) return 'Too few reviews for an interval';
  const { low, high } = adjustment.interval;
  return `${fmt(low)} to ${fmt(high)}`;
}

function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/**
 * Why nothing is applied, said the way a person would say it.
 *
 * The server sends a full sentence in `statement`; this is the short form for
 * the status column beside it. Neither ever says a reviewer was wrong.
 */
const HOLD_LABELS: Readonly<Record<string, string>> = {
  too_few_observations: 'Too few reviews yet',
  too_few_reviewers: 'Too few reviewers yet',
  no_interval: 'Too few reviews to be sure',
  interval_includes_zero: 'No settled gap',
  estimate_outside_interval: 'The evidence disagrees with itself',
  reviewers_disagree: 'Reviewers do not point the same way',
  below_smallest_step: 'Measured, too small to apply',
  fairness_flagged: 'Held for a person to look at',
  switched_off: 'Calibration is off',
};

export function holdLabel(holdReason: string): string {
  return HOLD_LABELS[holdReason] ?? 'Not applied';
}

export function statusLabel(adjustment: Pick<Adjustment, 'status' | 'holdReason'>): string {
  if (adjustment.status === 'active') return 'Applied';
  if (adjustment.status === 'reverted') return 'Switched off by a person';
  return holdLabel(adjustment.holdReason);
}

/**
 * The three groups the page shows, in the order an admin cares about them:
 * what is changing scores, what a person switched off, and what is merely
 * being watched.
 */
export interface AdjustmentGroups {
  readonly applied: readonly Adjustment[];
  readonly reverted: readonly Adjustment[];
  readonly watching: readonly Adjustment[];
}

export function groupAdjustments(adjustments: readonly Adjustment[]): AdjustmentGroups {
  return {
    applied: adjustments.filter((a) => a.status === 'active' && a.delta !== 0),
    reverted: adjustments.filter((a) => a.status === 'reverted'),
    watching: adjustments.filter((a) => a.status !== 'reverted' && !(a.status === 'active' && a.delta !== 0)),
  };
}

/** The one line at the top of the tab: what calibration is doing right now. */
export function headline(settings: CalibrationSettings, groups: AdjustmentGroups): string {
  if (!settings.platformEnabled) {
    return 'Calibration is switched off for this deployment, so nothing is being learned or applied.';
  }
  if (!settings.organisationEnabled) {
    return 'Calibration is off for your organisation. Reviews are still recorded, so switching it on later starts from evidence you already have.';
  }
  if (groups.applied.length === 0) {
    return `Nothing is being adjusted. ${groups.watching.length} competenc${groups.watching.length === 1 ? 'y is' : 'ies are'} being watched, and none has met the evidence bar yet.`;
  }
  const n = groups.applied.length;
  return `${n} competenc${n === 1 ? 'y is' : 'ies are'} being scored at the level your reviewers have consistently read the evidence at. The model's own level is kept and shown on every assessment.`;
}

/** The bar an adjustment must clear, said once, near the numbers it governs. */
export function thresholdSentence(settings: CalibrationSettings): string {
  const t = settings.thresholds;
  return `Nothing is applied until at least ${t.minObservations} reviews from at least ${t.minReviewers} different reviewers point the same way, and never by more than ${t.maxAbsDelta} level.`;
}

// ---------------------------------------------------------------------------
// Reviewer patterns
// ---------------------------------------------------------------------------

export interface Proportion {
  readonly count: number;
  readonly n: number;
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

export interface ReviewerStatistics {
  readonly reviewerId: string;
  readonly reviews: number;
  readonly tooFewToSay: boolean;
  readonly minimumReviews: number;
  readonly divergenceFromAi: Proportion | null;
  readonly verdictMix: Readonly<Record<string, Proportion>> | null;
  readonly downwardShare: Proportion | null;
  readonly overridesTotal: number;
  readonly reasonGiven: Proportion | null;
  readonly medianSecondsToRecord: number | null;
  readonly timingKnownFor: number;
  readonly peerGap: { readonly n: number; readonly meanAbsGap: number } | null;
}

export interface PatternAlert {
  readonly reviewerId: string;
  readonly kind: string;
  readonly sample: number;
  readonly observed: number;
  readonly baseline: number;
  readonly statement: string;
}

export interface ReviewerPattern {
  readonly reviewerId: string;
  readonly name: string;
  readonly statistics: ReviewerStatistics;
  readonly alerts: readonly PatternAlert[];
  readonly openAlertKinds: readonly string[];
  readonly heldOutOfCalibration: boolean;
}

export interface PatternReportResponse {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly minimumReviews: number;
  readonly baseline: {
    readonly reviews: number;
    readonly reviewers: number;
    readonly divergenceFromAi: number | null;
    readonly downwardShare: number | null;
    readonly medianSecondsToRecord: number | null;
  };
  readonly reviewers: readonly ReviewerPattern[];
  readonly notice: string;
}

export function percentLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Not known';
  return `${Math.round(value * 100)}%`;
}

/** A proportion with its interval, so a small sample cannot read as precision. */
export function proportionLabel(p: Proportion | null): string {
  if (!p || p.n === 0) return 'Not known';
  return `${Math.round(p.value * 100)}% (${Math.round(p.low * 100)}–${Math.round(p.high * 100)}%)`;
}

export function durationLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'Not recorded';
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 360) / 10} hours`;
}

/**
 * What a reviewer's row says when there is not enough to say anything.
 *
 * This is a first-class state, not an empty one: below the minimum, the page
 * shows this sentence INSTEAD of any statistic, so nobody reads a number that
 * a handful of reviews cannot support.
 */
export function tooFewSentence(statistics: Pick<ReviewerStatistics, 'reviews' | 'minimumReviews'>): string {
  return `${statistics.reviews} review${statistics.reviews === 1 ? '' : 's'} in this period — too few to say anything. Nothing is shown until there are at least ${statistics.minimumReviews}.`;
}
