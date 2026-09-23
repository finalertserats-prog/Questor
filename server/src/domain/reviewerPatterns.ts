// Reviewer patterns: what the organisation's admin can see about how its own
// reviewers review, computed from the same observations calibration uses.
//
// WHY THIS EXISTS
// Calibration learns from humans, so it inherits whatever the humans brought
// with them. If one reviewer consistently marks a role down, the model learns
// to mark that role down. The owner asked for the other half of that: if there
// is a pattern in how a person reviews, a person should look at it.
//
// WHAT THIS IS NOT, AND MUST NEVER BECOME
//
//   * It is NOT a finding. A pattern is a question ("worth a look"), never an
//     answer. Nothing here may conclude that a reviewer is biased, unfair or
//     wrong, and the vocabulary is tested (`NEVER_SAY`) so it cannot drift.
//   * NOTHING IS DONE TO THE REVIEWER automatically. No status changes, no
//     access is removed, no decision of theirs is reversed, and nobody is told
//     anything about them except their own organisation's admin.
//
//     There IS one automatic effect, and being precise about it matters more
//     than sounding reassuring: while an alert is open, that reviewer's
//     observations stop feeding calibration. That is a brake on what the MODEL
//     learns, not a sanction on the person — it stops one unusual pattern
//     teaching the scoring something before anybody has looked at it. It
//     applies only to the kinds that rest on a proportion with a confidence
//     interval (see HOLDS_OUT), and it ends when an admin closes the alert,
//     whichever way they close it.
//   * It is NOT a performance record. These numbers must never reach anyone's
//     appraisal, rating or standing inside Questor. There is no code path from
//     here to any such thing and there must never be one.
//   * It is NOT secret from the reviewer. Every reviewer can read their own
//     figures — the same numbers the admin sees, from this same module. Where
//     employee data is processed that is a legal requirement, not a courtesy.
//
// Small samples say nothing, loudly: below the minimum, `tooFewToSay` is the
// whole answer and no statistic is offered at all.
//
// Pure and DB-free.

import type { CalibrationThresholds } from './calibration.js';

/** Vocabulary this module may never use about a person. Enforced by test. */
export const NEVER_SAY = [
  'bias', 'biased', 'unfair', 'discriminat', 'wrong', 'incorrect', 'mistake',
  'too harsh', 'too lenient', 'poor', 'bad reviewer', 'underperform', 'rubber stamp',
] as const;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One completed review, reduced to what a pattern can be computed from. */
export interface ReviewRecord {
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly assessmentId: string;
  readonly roleKey: string;
  readonly aiVerdict: string;
  readonly humanVerdict: string;
  readonly agreedWithAi: boolean;
  /** Level overrides, split by direction. */
  readonly overridesDown: number;
  readonly overridesUp: number;
  readonly competencyCount: number;
  /** Overrides that carried the reviewer's own words. */
  readonly overridesWithReason: number;
  /** Characters of reasoning recorded across the whole review. */
  readonly reasonChars: number;
  /**
   * Seconds between the reviewer first seeing the assessment and recording a
   * verdict. Null when the opening was never recorded — and null is reported,
   * never guessed.
   */
  readonly secondsToRecord: number | null;
  readonly recordedAt: Date;
  readonly blindReview: boolean;
}

/** One reviewer's level on one role's competency, for comparing against their peers. */
export interface PeerLevel {
  readonly reviewerId: string;
  readonly roleKey: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly level: number;
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

export interface Proportion {
  readonly count: number;
  readonly n: number;
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

const Z_95 = 1.959964;

/**
 * A Wilson score interval: well-behaved at the small samples and extreme
 * proportions this deals in, where the textbook normal interval produces
 * bounds outside 0..1 and a false sense of precision.
 */
export function proportion(count: number, n: number): Proportion {
  if (n <= 0) return { count, n: 0, value: 0, low: 0, high: 1 };
  const p = count / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z_95 / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    count, n,
    value: round4(p),
    low: round4(Math.max(0, centre - half)),
    high: round4(Math.min(1, centre + half)),
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// The statistics
// ---------------------------------------------------------------------------

export interface ReviewerStatistics {
  readonly reviewerId: string;
  readonly reviews: number;
  /** True when the sample is below the minimum. Everything below is then null. */
  readonly tooFewToSay: boolean;
  readonly minimumReviews: number;
  readonly divergenceFromAi: Proportion | null;
  readonly verdictMix: Readonly<Record<string, Proportion>> | null;
  /** Of all level overrides, the share that moved a level down. */
  readonly downwardShare: Proportion | null;
  readonly overridesTotal: number;
  /** Of all level overrides, the share where the reviewer wrote down why. */
  readonly reasonGiven: Proportion | null;
  readonly medianReasonChars: number | null;
  readonly medianSecondsToRecord: number | null;
  readonly timingKnownFor: number;
  /** Mean distance from what other reviewers recorded on the same role competency. */
  readonly peerGap: { readonly n: number; readonly meanAbsGap: number } | null;
  readonly blindShare: Proportion | null;
}

export interface OrganisationBaseline {
  readonly reviews: number;
  readonly reviewers: number;
  readonly divergenceFromAi: number | null;
  readonly verdictMix: Readonly<Record<string, number>>;
  readonly downwardShare: number | null;
  readonly reasonGiven: number | null;
  readonly medianSecondsToRecord: number | null;
  readonly meanPeerGap: number | null;
}

export const VERDICT_KEYS = ['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS'] as const;

/**
 * Mean distance between each reviewer's level and the median of what OTHER
 * reviewers recorded on the same role, competency and band.
 *
 * Their own level is excluded from the median they are compared against —
 * otherwise a reviewer who reviews most of a role is largely compared with
 * themselves and always looks agreeable.
 */
export function peerGaps(rows: readonly PeerLevel[]): Map<string, { n: number; meanAbsGap: number }> {
  const groups = new Map<string, PeerLevel[]>();
  for (const row of rows) {
    const key = `${row.roleKey}|${row.competencyKey}|${row.band}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const perReviewer = new Map<string, number[]>();
  for (const group of groups.values()) {
    for (const row of group) {
      const others = group.filter((r) => r.reviewerId !== row.reviewerId).map((r) => r.level);
      const peer = median(others);
      if (peer === null) continue;
      const gaps = perReviewer.get(row.reviewerId) ?? [];
      gaps.push(Math.abs(row.level - peer));
      perReviewer.set(row.reviewerId, gaps);
    }
  }
  const out = new Map<string, { n: number; meanAbsGap: number }>();
  for (const [reviewerId, gaps] of perReviewer) {
    out.set(reviewerId, { n: gaps.length, meanAbsGap: round4(gaps.reduce((a, g) => a + g, 0) / gaps.length) });
  }
  return out;
}

export function reviewerStatistics(
  reviewerId: string,
  reviews: readonly ReviewRecord[],
  peerGap: { n: number; meanAbsGap: number } | undefined,
  thresholds: CalibrationThresholds,
): ReviewerStatistics {
  const mine = reviews.filter((r) => r.reviewerId === reviewerId);
  const minimumReviews = thresholds.reviewerPatternMinReviews;
  if (mine.length < minimumReviews) {
    return {
      reviewerId, reviews: mine.length, tooFewToSay: true, minimumReviews,
      divergenceFromAi: null, verdictMix: null, downwardShare: null, overridesTotal: 0,
      reasonGiven: null, medianReasonChars: null, medianSecondsToRecord: null, timingKnownFor: 0,
      peerGap: null, blindShare: null,
    };
  }

  const n = mine.length;
  const overridesDown = mine.reduce((a, r) => a + r.overridesDown, 0);
  const overridesUp = mine.reduce((a, r) => a + r.overridesUp, 0);
  const overridesTotal = overridesDown + overridesUp;
  const overridesWithReason = mine.reduce((a, r) => a + r.overridesWithReason, 0);
  const timings = mine.map((r) => r.secondsToRecord).filter((s): s is number => s !== null && Number.isFinite(s));

  const verdictMix: Record<string, Proportion> = {};
  for (const key of VERDICT_KEYS) {
    verdictMix[key] = proportion(mine.filter((r) => r.humanVerdict === key).length, n);
  }

  return {
    reviewerId,
    reviews: n,
    tooFewToSay: false,
    minimumReviews,
    divergenceFromAi: proportion(mine.filter((r) => !r.agreedWithAi).length, n),
    verdictMix,
    downwardShare: overridesTotal > 0 ? proportion(overridesDown, overridesTotal) : null,
    overridesTotal,
    reasonGiven: overridesTotal > 0 ? proportion(overridesWithReason, overridesTotal) : null,
    medianReasonChars: median(mine.map((r) => r.reasonChars)),
    medianSecondsToRecord: timings.length ? median(timings) : null,
    timingKnownFor: timings.length,
    peerGap: peerGap ?? null,
    blindShare: proportion(mine.filter((r) => r.blindReview).length, n),
  };
}

/** What the organisation as a whole looks like, so a reviewer is compared with colleagues. */
export function organisationBaseline(
  reviews: readonly ReviewRecord[],
  gaps: Map<string, { n: number; meanAbsGap: number }>,
): OrganisationBaseline {
  const n = reviews.length;
  const overridesDown = reviews.reduce((a, r) => a + r.overridesDown, 0);
  const overridesTotal = overridesDown + reviews.reduce((a, r) => a + r.overridesUp, 0);
  const withReason = reviews.reduce((a, r) => a + r.overridesWithReason, 0);
  const timings = reviews.map((r) => r.secondsToRecord).filter((s): s is number => s !== null && Number.isFinite(s));
  const verdictMix: Record<string, number> = {};
  for (const key of VERDICT_KEYS) verdictMix[key] = n ? round4(reviews.filter((r) => r.humanVerdict === key).length / n) : 0;
  const gapValues = [...gaps.values()].map((g) => g.meanAbsGap);
  return {
    reviews: n,
    reviewers: new Set(reviews.map((r) => r.reviewerId)).size,
    divergenceFromAi: n ? round4(reviews.filter((r) => !r.agreedWithAi).length / n) : null,
    verdictMix,
    downwardShare: overridesTotal ? round4(overridesDown / overridesTotal) : null,
    reasonGiven: overridesTotal ? round4(withReason / overridesTotal) : null,
    medianSecondsToRecord: timings.length ? median(timings) : null,
    meanPeerGap: gapValues.length ? round4(gapValues.reduce((a, g) => a + g, 0) / gapValues.length) : null,
  };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type PatternKind =
  | 'divergence_from_ai'
  | 'divergence_from_peers'
  | 'verdict_mix'
  | 'time_to_record'
  | 'override_direction'
  | 'evidence_cited'
  | 'pass_rate_skew';

export interface PatternAlert {
  readonly reviewerId: string;
  readonly kind: PatternKind;
  readonly sample: number;
  readonly observed: number;
  readonly baseline: number;
  /** Neutral, non-conclusive, and it asks a person to look. */
  readonly statement: string;
}

/**
 * How far from the organisation a proportion must sit before it is worth
 * anyone's time. Below this, a difference is real but not interesting, and
 * raising it would train people to ignore these.
 */
const MATERIAL_GAP = 0.2;

/** A verdict recorded faster than this has, on any reading, not been deliberated. */
const QUICK_SECONDS = 60;

function excludesBaseline(p: Proportion, baseline: number): boolean {
  return p.low > baseline || p.high < baseline;
}

/**
 * The patterns worth a person's attention, and nothing else.
 *
 * Every rule here needs three things at once: a sample at or above the minimum,
 * an interval that excludes the organisation's own baseline, and a gap large
 * enough to matter. Two out of three produces nothing. Small samples never
 * produce alerts — that is the point of the first condition, and it is tested.
 */
export function patternAlerts(
  stats: ReviewerStatistics,
  baseline: OrganisationBaseline,
  opts: { readonly passRateSkew?: { readonly observed: number; readonly baseline: number; readonly n: number } } = {},
): PatternAlert[] {
  if (stats.tooFewToSay) return [];
  const alerts: PatternAlert[] = [];
  const say = (kind: PatternKind, sample: number, observed: number, base: number, body: string) => {
    alerts.push({
      reviewerId: stats.reviewerId, kind, sample, observed: round4(observed), baseline: round4(base),
      statement: `Worth a look: ${body} This is a pattern over ${sample} review${sample === 1 ? '' : 's'}, not a finding — a person needs to look at it and decide whether there is anything to it.`,
    });
  };

  if (stats.divergenceFromAi && baseline.divergenceFromAi !== null
    && excludesBaseline(stats.divergenceFromAi, baseline.divergenceFromAi)
    && Math.abs(stats.divergenceFromAi.value - baseline.divergenceFromAi) >= MATERIAL_GAP) {
    say('divergence_from_ai', stats.reviews, stats.divergenceFromAi.value, baseline.divergenceFromAi,
      `this reviewer records a different verdict from the AI on ${pct(stats.divergenceFromAi.value)} of reviews, against ${pct(baseline.divergenceFromAi)} across the organisation.`);
  }

  if (stats.peerGap && baseline.meanPeerGap !== null && stats.peerGap.n >= stats.minimumReviews
    && stats.peerGap.meanAbsGap - baseline.meanPeerGap >= 0.5) {
    say('divergence_from_peers', stats.peerGap.n, stats.peerGap.meanAbsGap, baseline.meanPeerGap,
      `on the same role competencies, this reviewer's levels sit ${stats.peerGap.meanAbsGap.toFixed(2)} of a level away from what colleagues recorded, against ${baseline.meanPeerGap.toFixed(2)} across the organisation.`);
  }

  if (stats.verdictMix) {
    for (const key of VERDICT_KEYS) {
      const mine = stats.verdictMix[key]!;
      const base = baseline.verdictMix[key] ?? 0;
      if (excludesBaseline(mine, base) && Math.abs(mine.value - base) >= MATERIAL_GAP) {
        say('verdict_mix', stats.reviews, mine.value, base,
          `this reviewer records "${key}" on ${pct(mine.value)} of reviews, against ${pct(base)} across the organisation.`);
      }
    }
  }

  if (stats.medianSecondsToRecord !== null && stats.timingKnownFor >= stats.minimumReviews
    && stats.medianSecondsToRecord < QUICK_SECONDS
    && (baseline.medianSecondsToRecord === null || stats.medianSecondsToRecord < baseline.medianSecondsToRecord / 2)) {
    say('time_to_record', stats.timingKnownFor, stats.medianSecondsToRecord, baseline.medianSecondsToRecord ?? 0,
      `verdicts here are typically recorded ${Math.round(stats.medianSecondsToRecord)} seconds after the assessment is opened${baseline.medianSecondsToRecord !== null ? `, against ${Math.round(baseline.medianSecondsToRecord)} seconds across the organisation` : ''}.`);
  }

  if (stats.downwardShare && baseline.downwardShare !== null && stats.overridesTotal >= stats.minimumReviews
    && excludesBaseline(stats.downwardShare, baseline.downwardShare)
    && Math.abs(stats.downwardShare.value - baseline.downwardShare) >= MATERIAL_GAP) {
    say('override_direction', stats.overridesTotal, stats.downwardShare.value, baseline.downwardShare,
      `${pct(stats.downwardShare.value)} of this reviewer's level changes move a level down, against ${pct(baseline.downwardShare)} across the organisation.`);
  }

  if (stats.reasonGiven && baseline.reasonGiven !== null && stats.overridesTotal >= stats.minimumReviews
    && stats.reasonGiven.high < baseline.reasonGiven
    && baseline.reasonGiven - stats.reasonGiven.value >= MATERIAL_GAP) {
    say('evidence_cited', stats.overridesTotal, stats.reasonGiven.value, baseline.reasonGiven,
      `${pct(stats.reasonGiven.value)} of this reviewer's level changes record why, against ${pct(baseline.reasonGiven)} across the organisation.`);
  }

  const skew = opts.passRateSkew;
  if (skew && skew.n >= stats.minimumReviews) {
    // A rate supplied as a bare number is still a proportion over a sample, so
    // it gets the same interval as every other proportion here. Without it, a
    // noisy raw gap could open an alert AND hold a reviewer out of
    // calibration — a consequence on the thinnest possible evidence.
    const observed = proportion(Math.round(skew.observed * skew.n), skew.n);
    if (excludesBaseline(observed, skew.baseline) && Math.abs(observed.value - skew.baseline) >= MATERIAL_GAP) {
      say('pass_rate_skew', skew.n, observed.value, skew.baseline,
        `candidates reviewed here reach the next stage ${pct(observed.value)} of the time, against ${pct(skew.baseline)} for the same roles across the organisation.`);
    }
  }

  return alerts;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Reviewers held out of calibration while an admin looks.
 *
 * TWO conditions, and both are deliberate.
 *
 * First, the pattern must be one that would actually skew what the model
 * learns. How quickly a person records a verdict, or how much they write down,
 * is worth a look and is not a reason to discard their judgement.
 *
 * Second — and this is the one that is easy to get wrong — the pattern must
 * rest on a proportion with a confidence interval that excluded the
 * organisation's baseline. `divergence_from_peers` is a mean distance in
 * levels, not a proportion; there is no interval behind it, so it is raised
 * for a person to look at and has NO consequence of its own. A consequence on
 * evidence we cannot put an interval around is exactly the kind of quiet
 * unfairness this whole feature is supposed to be careful about.
 */
const HOLDS_OUT: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'divergence_from_ai', 'verdict_mix', 'override_direction', 'pass_rate_skew',
]);

export function heldOutReviewers(openAlerts: ReadonlyArray<{ reviewerId: string; kind: PatternKind }>): string[] {
  const out = new Set<string>();
  for (const alert of openAlerts) if (HOLDS_OUT.has(alert.kind)) out.add(alert.reviewerId);
  return [...out];
}
