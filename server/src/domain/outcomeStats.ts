import { VERDICTS, VERDICT_LABELS, isVerdict, type Verdict } from './verdict.js';

/**
 * Outcome statistics: what actually happens to candidates at each step, and
 * whether outcomes differ by interviewer, question set, band or month in ways
 * nobody intended.
 *
 * WHAT THIS IS NOT. This is not an adverse-impact analysis and cannot become
 * one here. Adverse impact is measured across protected groups, and Questor
 * does not collect group attributes — there is nothing in this file, or in the
 * database behind it, that knows a candidate's race, sex, age or disability.
 * What this file measures is the layer underneath: the outcome rates
 * themselves, cut by things the product does record. That measurement layer is
 * a precondition for group-level monitoring; it is not a substitute for it,
 * and no wording built on these numbers may suggest otherwise.
 *
 * THE SMALL-SAMPLE RULE. Every rate here is a `Rate`, which carries its
 * numerator and denominator and a `readable` flag. `readable` is false below
 * OUTCOME_MIN_SAMPLE observations. The value is still computed — an export
 * that dropped it would lose the counts too — but nothing downstream may print
 * the percentage of an unreadable rate without saying it is too small to read.
 * Three of four is not seventy-five per cent of anything.
 *
 * Everything in this file is pure: no database, no clock, no tenant. That is
 * what lets the arithmetic on the outcome panel be checked against fixtures
 * with known answers (tests/outcomeStats.test.ts).
 */

/**
 * The denominator below which a rate must not be read.
 *
 * Deliberately larger than roleMetrics' MIN_SAMPLE (5), which governs an
 * operational "how is this requisition moving" figure a recruiter reads as a
 * rough signal. These rates get compared BETWEEN groups — this interviewer
 * against that one — and a difference between two small proportions is noise
 * almost all of the time. Twenty is a conventional floor for reading a
 * proportion at all; it is not a power calculation, and it does not make a
 * difference between two twenty-sample groups significant.
 */
export const OUTCOME_MIN_SAMPLE = 20;

/** Four decimal places, the same precision shadowModeCommon.round reports. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Two decimal places, for a value on a human scale (minutes, a 0-100 score, a 1-5 level). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A proportion that always arrives with the sample it was computed on.
 *
 * `value` is null only when there was nothing to divide by. A zero denominator
 * is not "zero per cent": it is the absence of a measurement, and the two must
 * never render the same way.
 */
export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
  /** False below the minimum sample: the number exists, but it is not a rate anyone may read. */
  readonly readable: boolean;
}

export function rateOf(numerator: number, denominator: number, minSample: number = OUTCOME_MIN_SAMPLE): Rate {
  return {
    numerator,
    denominator,
    value: denominator > 0 ? round4(numerator / denominator) : null,
    readable: denominator >= minSample,
  };
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

export const FUNNEL_KEYS = [
  'invited', 'started', 'completed', 'assessed', 'humanReviewed',
  'proceed', 'consider', 'doNotProgress', 'hired',
] as const;
export type FunnelKey = (typeof FUNNEL_KEYS)[number];
export type FunnelCounts = Readonly<Record<FunnelKey, number>>;

/**
 * Where each step's rate is read from.
 *
 * The three verdicts all divide by `humanReviewed`, not by one another: they
 * are a split of one population, not a chain. Reading "Consider" against
 * "Proceed" would invent a sequence that nobody goes through.
 *
 * Hiring divides by `proceed`, because that is the decision it follows from.
 */
const FUNNEL_SPEC: ReadonlyArray<{ key: FunnelKey; label: string; basis: FunnelKey | null }> = [
  { key: 'invited', label: 'Invited', basis: null },
  { key: 'started', label: 'Started', basis: 'invited' },
  { key: 'completed', label: 'Completed', basis: 'started' },
  { key: 'assessed', label: 'Assessed', basis: 'completed' },
  { key: 'humanReviewed', label: 'Reviewed by a person', basis: 'assessed' },
  { key: 'proceed', label: VERDICT_LABELS.PROCEED, basis: 'humanReviewed' },
  { key: 'consider', label: VERDICT_LABELS.CONSIDER, basis: 'humanReviewed' },
  { key: 'doNotProgress', label: VERDICT_LABELS.DO_NOT_PROGRESS, basis: 'humanReviewed' },
  { key: 'hired', label: 'Hired', basis: 'proceed' },
];

export interface FunnelStep {
  readonly key: FunnelKey;
  readonly label: string;
  readonly count: number;
  readonly basis: FunnelKey | null;
  /** This step against the step it came from; null for the first step. */
  readonly ofBasis: Rate | null;
  /** This step against everyone who was invited; null for the first step. */
  readonly ofInvited: Rate | null;
}

export function buildFunnel(counts: FunnelCounts, minSample: number = OUTCOME_MIN_SAMPLE): readonly FunnelStep[] {
  return FUNNEL_SPEC.map((spec) => ({
    key: spec.key,
    label: spec.label,
    count: counts[spec.key],
    basis: spec.basis,
    ofBasis: spec.basis === null ? null : rateOf(counts[spec.key], counts[spec.basis], minSample),
    ofInvited: spec.basis === null ? null : rateOf(counts[spec.key], counts.invited, minSample),
  }));
}

// ---------------------------------------------------------------------------
// The row every statistic is folded from
// ---------------------------------------------------------------------------

/**
 * One AI interview, flattened.
 *
 * Deliberately one row per interview rather than per candidate: a retake is a
 * separate interview (InterviewSession.attemptNumber), and folding it into the
 * first attempt would hide exactly the thing a health statistic is for.
 *
 * Nothing here identifies a person. The candidate's name, address and
 * transcript stay in the database; what crosses into the statistics is the
 * shape of what happened.
 */
export interface OutcomeRow {
  readonly sessionId: string;
  readonly roleId: string;
  readonly roleTitle: string;
  /** '' when the interview predates the interviewer catalogue. */
  readonly interviewerId: string;
  readonly interviewerName: string;
  /** '' when the role does not record one. */
  readonly experienceBand: string;
  /** '' when the role does not record one. */
  readonly regionCode: string;
  readonly scorecardId: string;
  readonly scorecardLabel: string;
  /**
   * 'YYYY-MM' of when the interview was created, in UTC.
   *
   * By creation, not by completion or decision: a month then follows ONE
   * cohort forward, and its funnel rates are rates of the same people. Bucketing
   * by decision date would divide this month's decisions by this month's
   * invitations, which are different candidates.
   */
  readonly month: string;
  readonly invited: boolean;
  readonly started: boolean;
  readonly completed: boolean;
  readonly assessed: boolean;
  readonly aiVerdict: Verdict | null;
  readonly humanReviewed: boolean;
  readonly humanVerdict: Verdict | null;
  readonly hired: boolean;
  readonly overallScore: number | null;
  readonly competencyLevels: ReadonlyArray<{ readonly id: string; readonly name: string; readonly level: number }>;
  /** Wall-clock minutes from start to completion; null when the interview did not finish. */
  readonly durationMinutes: number | null;
  readonly candidateTurns: number;
  readonly nonAnswerTurns: number;
  readonly evidenceCoverage: number | null;
  /** How many times the candidate came back into the room after losing it. */
  readonly rejoins: number;
  readonly feedbackHeld: boolean;
  readonly agentTurns: number;
  /** Agent turns written below the primary model because it was unavailable. */
  readonly degradedTurns: number;
}

export function countFunnel(rows: readonly OutcomeRow[]): FunnelCounts {
  const count = (predicate: (r: OutcomeRow) => boolean) => rows.filter(predicate).length;
  return {
    invited: count((r) => r.invited),
    started: count((r) => r.started),
    completed: count((r) => r.completed),
    assessed: count((r) => r.assessed),
    humanReviewed: count((r) => r.humanReviewed),
    proceed: count((r) => r.humanVerdict === 'PROCEED'),
    consider: count((r) => r.humanVerdict === 'CONSIDER'),
    doNotProgress: count((r) => r.humanVerdict === 'DO_NOT_PROGRESS'),
    hired: count((r) => r.hired),
  };
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

export interface Quantiles {
  readonly n: number;
  readonly median: number | null;
  readonly q1: number | null;
  readonly q3: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly readable: boolean;
}

/**
 * The p-th quantile by linear interpolation between order statistics (the R-7
 * definition, which is also Excel's PERCENTILE.INC). Named because there are
 * nine of them in common use and they disagree on small samples — the one in
 * use has to be stated rather than left to whichever library is installed.
 */
function quantileAt(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return round2(sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]));
}

/**
 * The spread of a sample — median and quartiles, never a bare mean. An average
 * competency score hides the shape that matters: two cohorts with the same mean
 * and different spreads are not the same cohort.
 */
export function quantiles(values: readonly number[], minSample: number = OUTCOME_MIN_SAMPLE): Quantiles {
  const n = values.length;
  if (n === 0) return { n: 0, median: null, q1: null, q3: null, min: null, max: null, readable: false };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n,
    median: quantileAt(sorted, 0.5),
    q1: quantileAt(sorted, 0.25),
    q3: quantileAt(sorted, 0.75),
    min: round2(sorted[0]),
    max: round2(sorted[n - 1]),
    readable: n >= minSample,
  };
}

export interface LevelCount {
  readonly level: number;
  readonly count: number;
}

export interface LevelDistribution extends Quantiles {
  readonly counts: readonly LevelCount[];
}

/**
 * Counts per level on a named scale, plus the spread. Every level on the scale
 * appears, including the ones nobody was given — a level with no candidates in
 * it is a fact about the cohort, and leaving it out of the chart would close
 * the gap it should show.
 *
 * A value that is not on the scale is dropped rather than bucketed into the
 * nearest level; it is a data-quality problem, not a score.
 */
export function levelDistribution(
  values: readonly number[],
  levels: readonly number[],
  minSample: number = OUTCOME_MIN_SAMPLE,
): LevelDistribution {
  const onScale = values.filter((v) => levels.includes(v));
  return {
    ...quantiles(onScale, minSample),
    counts: levels.map((level) => ({ level, count: onScale.filter((v) => v === level).length })),
  };
}

export interface ScoreBucket {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

export interface ScoreDistribution extends Quantiles {
  readonly buckets: readonly ScoreBucket[];
}

/** Overall scores (0-100) bucketed for a histogram, plus the spread of the scores themselves. */
export function scoreDistribution(
  values: readonly number[],
  bucketSize = 10,
  minSample: number = OUTCOME_MIN_SAMPLE,
): ScoreDistribution {
  const spread = quantiles(values, minSample);
  if (values.length === 0) return { ...spread, buckets: [] };
  const bucketCount = Math.ceil(100 / bucketSize);
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({ from: i * bucketSize, to: (i + 1) * bucketSize, count: 0 }));
  for (const value of values) {
    // A perfect score belongs in the last bucket, not in a bucket past the end.
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor(value / bucketSize)));
    buckets[index].count += 1;
  }
  return { ...spread, buckets };
}

// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------

export const CUT_DIMENSIONS = ['interviewer', 'experienceBand', 'region', 'scorecard', 'month'] as const;
export type CutDimension = (typeof CUT_DIMENSIONS)[number];

export const CUT_DIMENSION_LABELS: Readonly<Record<CutDimension, string>> = {
  interviewer: 'AI interviewer',
  experienceBand: 'Experience band',
  region: 'Region',
  scorecard: 'Scorecard version',
  month: 'Month',
};

/** The group a row falls into for a dimension, and what to call it. */
function groupOf(row: OutcomeRow, dimension: CutDimension): { key: string; label: string } {
  switch (dimension) {
    case 'interviewer': return { key: row.interviewerId, label: row.interviewerName };
    case 'experienceBand': return { key: row.experienceBand, label: row.experienceBand };
    case 'region': return { key: row.regionCode, label: row.regionCode };
    case 'scorecard': return { key: row.scorecardId, label: row.scorecardLabel };
    case 'month': return { key: row.month, label: row.month };
  }
}

/**
 * Rows with nothing recorded for the dimension. Named rather than dropped: a
 * cut that silently excluded them would have a denominator smaller than the
 * period it claims to describe.
 */
const UNRECORDED_LABEL = 'Not recorded';

export interface CutGroup {
  readonly key: string;
  readonly label: string;
  /** Interviews in this group. Every rate below divides by this or by a subset of it. */
  readonly n: number;
  readonly started: Rate;
  readonly completed: Rate;
  readonly assessed: Rate;
  readonly humanReviewed: Rate;
  /** The AI's own recommendation, over the interviews it assessed. */
  readonly aiVerdicts: Readonly<Record<Verdict, Rate>>;
  /** The reviewer's verdict, over the interviews a person reviewed. */
  readonly humanVerdicts: Readonly<Record<Verdict, Rate>>;
  readonly hired: Rate;
  readonly score: Quantiles;
  /** False when this group is below the minimum sample; no rate in it may be read. */
  readonly readable: boolean;
}

function verdictRates(
  rows: readonly OutcomeRow[],
  verdictOf: (r: OutcomeRow) => Verdict | null,
  denominator: number,
  minSample: number,
): Readonly<Record<Verdict, Rate>> {
  return Object.fromEntries(
    VERDICTS.map((v) => [v, rateOf(rows.filter((r) => verdictOf(r) === v).length, denominator, minSample)]),
  ) as Record<Verdict, Rate>;
}

/**
 * Outcomes grouped by one dimension, every group carrying its sample size.
 *
 * Ordered largest-first, except a monthly cut, which is ordered by month so a
 * trend reads left to right. Nothing here ranks groups by outcome or flags a
 * group as an outlier: with samples this size that would be a claim the
 * arithmetic cannot support, and the page says so instead.
 */
export function cutBy(
  rows: readonly OutcomeRow[],
  dimension: CutDimension,
  minSample: number = OUTCOME_MIN_SAMPLE,
): readonly CutGroup[] {
  const grouped = new Map<string, { label: string; rows: OutcomeRow[] }>();
  for (const row of rows) {
    const { key, label } = groupOf(row, dimension);
    const entry = grouped.get(key) ?? { label: label.trim() || UNRECORDED_LABEL, rows: [] };
    entry.rows.push(row);
    grouped.set(key, entry);
  }

  const groups = [...grouped.entries()].map(([key, entry]): CutGroup => {
    const n = entry.rows.length;
    const assessed = entry.rows.filter((r) => r.assessed);
    const reviewed = entry.rows.filter((r) => r.humanReviewed);
    return {
      key,
      label: entry.label,
      n,
      started: rateOf(entry.rows.filter((r) => r.started).length, n, minSample),
      completed: rateOf(entry.rows.filter((r) => r.completed).length, n, minSample),
      assessed: rateOf(assessed.length, n, minSample),
      humanReviewed: rateOf(reviewed.length, n, minSample),
      aiVerdicts: verdictRates(assessed, (r) => r.aiVerdict, assessed.length, minSample),
      humanVerdicts: verdictRates(reviewed, (r) => r.humanVerdict, reviewed.length, minSample),
      hired: rateOf(entry.rows.filter((r) => r.hired).length, n, minSample),
      score: quantiles(entry.rows.flatMap((r) => (r.overallScore === null ? [] : [r.overallScore])), minSample),
      readable: n >= minSample,
    };
  });

  return dimension === 'month'
    ? groups.sort((a, b) => a.key.localeCompare(b.key))
    : groups.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Interview health
// ---------------------------------------------------------------------------

export interface MeanOf {
  readonly n: number;
  readonly mean: number | null;
  readonly readable: boolean;
}

export interface HealthStats {
  readonly n: number;
  readonly duration: Quantiles;
  /** Candidate turns that said nothing, over all candidate turns. */
  readonly nonAnswer: Rate;
  readonly evidenceCoverage: MeanOf;
  /** Interviews the candidate came back into, over all interviews — not rejoin events. */
  readonly rejoined: Rate;
  readonly heldFeedback: Rate;
  /** Agent turns served below the primary model, over all agent turns. */
  readonly degradedTurns: Rate;
}

function sum(rows: readonly OutcomeRow[], of: (r: OutcomeRow) => number): number {
  return rows.reduce((total, row) => total + of(row), 0);
}

export function healthStats(rows: readonly OutcomeRow[], minSample: number = OUTCOME_MIN_SAMPLE): HealthStats {
  const coverages = rows.flatMap((r) => (r.assessed && r.evidenceCoverage !== null ? [r.evidenceCoverage] : []));
  return {
    n: rows.length,
    duration: quantiles(rows.flatMap((r) => (r.durationMinutes === null ? [] : [r.durationMinutes])), minSample),
    nonAnswer: rateOf(sum(rows, (r) => r.nonAnswerTurns), sum(rows, (r) => r.candidateTurns), minSample),
    evidenceCoverage: {
      n: coverages.length,
      mean: coverages.length ? round4(coverages.reduce((a, b) => a + b, 0) / coverages.length) : null,
      readable: coverages.length >= minSample,
    },
    rejoined: rateOf(rows.filter((r) => r.rejoins > 0).length, rows.length, minSample),
    heldFeedback: rateOf(rows.filter((r) => r.feedbackHeld).length, rows.length, minSample),
    degradedTurns: rateOf(sum(rows, (r) => r.degradedTurns), sum(rows, (r) => r.agentTurns), minSample),
  };
}

// ---------------------------------------------------------------------------
// Human vs AI, where the reviewer had already seen the AI
// ---------------------------------------------------------------------------

/** A ReviewDifference row, flattened. */
export interface ReviewDifferenceRow {
  readonly aiRecommendation: string;
  readonly humanDisposition: string;
  readonly agreed: boolean;
  readonly competencies: ReadonlyArray<{
    readonly competencyId: string;
    readonly competencyName: string;
    readonly aiLevel: number | null;
    readonly humanLevel: number | null;
    readonly changed: boolean;
  }>;
}

export interface UnblindedAgreement {
  readonly n: number;
  readonly agreed: Rate;
  readonly byAiRecommendation: ReadonlyArray<{
    readonly recommendation: Verdict;
    readonly n: number;
    readonly agreed: Rate;
    readonly humanCounts: Readonly<Record<Verdict, number>>;
  }>;
  readonly competencyChanges: {
    readonly changed: Rate;
    /** Competencies the AI graded above the reviewer. */
    readonly aiHigher: number;
    /** Competencies the reviewer graded above the AI. */
    readonly humanHigher: number;
  };
}

/**
 * How often a completed review landed on the same verdict the AI had already
 * shown the reviewer, and where the two parted company.
 *
 * THIS IS NOT AN AGREEMENT STATISTIC ABOUT THE SCORING. A reviewer who opens
 * the AI's PROCEED and then agrees with it is anchoring, not measuring; the
 * only agreement figure that means anything about validity is the one computed
 * over BLIND verdicts by services/shadowMode.ts, against the gate in
 * docs/VALIDATION.md. This function exists for the other question — where
 * reviewers actually change the AI's mind, which is what the AI is meant to
 * learn from — and every surface that renders it must say which of the two it
 * is showing.
 *
 * Rows whose verdicts are not in the one vocabulary (domain/verdict.ts) are
 * dropped: a stored APPROVED is a pipeline decision, not a review verdict, and
 * counting it here would mix two different acts.
 */
export function unblindedAgreement(
  rows: readonly ReviewDifferenceRow[],
  minSample: number = OUTCOME_MIN_SAMPLE,
): UnblindedAgreement {
  const usable = rows.filter((r) => isVerdict(r.aiRecommendation) && isVerdict(r.humanDisposition));
  const competencies = usable.flatMap((r) => r.competencies);
  const moved = competencies.filter((c) => c.aiLevel !== null && c.humanLevel !== null && c.aiLevel !== c.humanLevel);

  return {
    n: usable.length,
    agreed: rateOf(usable.filter((r) => r.humanDisposition === r.aiRecommendation).length, usable.length, minSample),
    byAiRecommendation: VERDICTS.map((recommendation) => {
      const forRecommendation = usable.filter((r) => r.aiRecommendation === recommendation);
      return {
        recommendation,
        n: forRecommendation.length,
        agreed: rateOf(forRecommendation.filter((r) => r.humanDisposition === recommendation).length, forRecommendation.length, minSample),
        humanCounts: Object.fromEntries(
          VERDICTS.map((v) => [v, forRecommendation.filter((r) => r.humanDisposition === v).length]),
        ) as Record<Verdict, number>,
      };
    }),
    competencyChanges: {
      changed: rateOf(competencies.filter((c) => c.changed).length, competencies.length, minSample),
      aiHigher: moved.filter((c) => (c.aiLevel as number) > (c.humanLevel as number)).length,
      humanHigher: moved.filter((c) => (c.humanLevel as number) > (c.aiLevel as number)).length,
    },
  };
}
