// Role calibration: what the AI learns from what human reviewers actually decided.
//
// WHAT THIS IS
// Reviewers override the AI's competency levels, record verdicts that differ
// from the AI's, and write down why. Until now that record (ReviewDifference)
// was kept and never read back into the scoring. This module is the arithmetic
// that turns it into a bounded, evidenced adjustment for the NEXT interview on
// that role.
//
// FOUR RULES, AND THEY ARE THE WHOLE DESIGN
//
//  1. FORWARD ONLY. A recorded assessment is never rewritten. Nothing here
//     takes an AssessmentVersion as input and nothing here produces one. A
//     calibration applies when an interview is assessed AFTER it became
//     active, and at no other time.
//  2. BOUNDED. At most one level, in half-level steps, on one role's one
//     competency at one band. There is no path by which this module can move a
//     score further, however loud the evidence.
//  3. EVIDENCED. Below the thresholds, nothing applies — and "nothing applies"
//     is the answer, not a smaller adjustment. A thin sample does not buy a
//     timid opinion; it buys silence.
//  4. THE HUMAN IS NEVER WRONG HERE. This module measures where people and the
//     model differ. It has no concept of a reviewer being mistaken, and it
//     must never acquire one. A disagreement is a signal about the rubric and
//     the model, never a finding about the person who recorded it.
//
// Pure and DB-free, so every rule above is a test rather than a claim.

import type { CompetencyCalibrationNote, Proficiency } from './types.js';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * A competency's name reduced to the one spelling calibration groups on, the
 * same reduction OrgCompetency.nameKey uses: "Vendor  Management" and
 * "vendor management" are one competency to learn about.
 *
 * Within an organisation the competency id is the real key — it is stable
 * across scorecard versions. The name key exists for the shared global
 * calibration, where ids mean nothing across organisations.
 */
export function competencyKeyOf(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The key a role calibrates under.
 *
 * The shared catalog's own id where the role has one, so two organisations
 * hiring the same catalog role can pool evidence; otherwise the role's own id,
 * which can never leave the organisation that owns it. The catalog is a shared
 * table, so a catalog id identifies a job and never an organisation.
 */
export function roleKeyOf(opts: { readonly catalogRoleId?: string | null; readonly roleId: string }): string {
  const catalogRoleId = (opts.catalogRoleId ?? '').trim();
  return catalogRoleId ? `catalog:${catalogRoleId}` : `role:${opts.roleId}`;
}

/** Only a catalog-keyed role can contribute to the shared calibration. */
export function isShareableRoleKey(roleKey: string): boolean {
  return roleKey.startsWith('catalog:');
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/** How far apart the two levels were. A loud disagreement must not read like a quiet one. */
export type DisagreementMagnitude = 'none' | 'minor' | 'major';

export function magnitudeOf(delta: number | null): DisagreementMagnitude {
  if (delta === null || !Number.isFinite(delta) || delta === 0) return 'none';
  return Math.abs(delta) >= 2 ? 'major' : 'minor';
}

/**
 * One paired judgement: what the AI said about one competency in one
 * interview, and what the reviewer left. Everything the aggregation is allowed
 * to see is on this record, and there is deliberately nothing on it about the
 * candidate.
 */
export interface CalibrationObservation {
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly competencyId: string;
  readonly competencyKey: string;
  readonly aiLevel: number | null;
  readonly humanLevel: number | null;
  /** humanLevel - aiLevel, or null when either side has no level. */
  readonly delta: number | null;
  readonly observedAt: Date;
  /** The reviewer's own words about this competency. Never interpreted as right or wrong. */
  readonly reasonText: string;
  readonly blindReview: boolean;
}

/** A pair both sides scored, which is the only kind the statistics can use. */
export function isPaired(o: CalibrationObservation): boolean {
  return o.delta !== null && Number.isFinite(o.delta);
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface CalibrationThresholds {
  /** Paired observations required before anything can apply. */
  readonly minObservations: number;
  /** Distinct reviewers required. One person cannot move a role's scoring. */
  readonly minReviewers: number;
  /** Share of contributing reviewers whose own median points the same way. */
  readonly minReviewerAgreement: number;
  /** No reviewer may carry more than this share of the weight. */
  readonly maxReviewerWeightShare: number;
  /** The hard bound on the applied adjustment, in levels. */
  readonly maxAbsDelta: number;
  /** Applied adjustments snap to this step. */
  readonly deltaStep: number;
  /** Below this, the measured gap is reported and NOT applied. */
  readonly minAbsDelta: number;
  /** Two-sided confidence for the median interval; it must exclude zero. */
  readonly confidence: number;
  /** Observations older than this are not evidence about how the role is judged today. */
  readonly windowDays: number;
  /** Recency weighting: an observation this old counts half. */
  readonly halfLifeDays: number;
  /** The largest pass-rate movement an activation may project before it is held. */
  readonly maxPassRateShift: number;
  /** Reviews a reviewer must have before any pattern about them is computed or shown. */
  readonly reviewerPatternMinReviews: number;
}

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  minObservations: 15,
  minReviewers: 3,
  minReviewerAgreement: 2 / 3,
  maxReviewerWeightShare: 0.4,
  maxAbsDelta: 1,
  deltaStep: 0.5,
  minAbsDelta: 0.5,
  confidence: 0.95,
  windowDays: 365,
  halfLifeDays: 180,
  maxPassRateShift: 0.1,
  reviewerPatternMinReviews: 10,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Thresholds with any caller-supplied overrides applied, each held inside a sane range. */
export function resolveThresholds(patch?: Partial<CalibrationThresholds>): CalibrationThresholds {
  const t = { ...DEFAULT_CALIBRATION_THRESHOLDS, ...(patch ?? {}) };
  const clamp = (v: number, lo: number, hi: number, fallback: number) =>
    (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  const minReviewers = Math.round(clamp(t.minReviewers, 3, 100, 3));
  return {
    minObservations: Math.round(clamp(t.minObservations, 5, 10_000, 15)),
    minReviewers,
    minReviewerAgreement: clamp(t.minReviewerAgreement, 0.5, 1, 2 / 3),
    // Never below 1/minReviewers: a 10% cap with three reviewers is a rule
    // nothing can satisfy, and the water-filling would spin without ever
    // reaching it. The floor keeps every setting feasible by construction.
    maxReviewerWeightShare: clamp(t.maxReviewerWeightShare, 1 / minReviewers, 1, 0.4),
    // The bound is a product promise, not a setting: an organisation may make
    // it tighter and can never make it looser than one level.
    maxAbsDelta: clamp(t.maxAbsDelta, 0, 1, 1),
    deltaStep: clamp(t.deltaStep, 0.5, 1, 0.5),
    minAbsDelta: clamp(t.minAbsDelta, 0.5, 1, 0.5),
    confidence: clamp(t.confidence, 0.8, 0.999, 0.95),
    windowDays: Math.round(clamp(t.windowDays, 30, 3650, 365)),
    halfLifeDays: Math.round(clamp(t.halfLifeDays, 7, 3650, 180)),
    maxPassRateShift: clamp(t.maxPassRateShift, 0.01, 1, 0.1),
    reviewerPatternMinReviews: Math.round(clamp(t.reviewerPatternMinReviews, 5, 1000, 10)),
  };
}

// ---------------------------------------------------------------------------
// Weighting
// ---------------------------------------------------------------------------

/** How much an observation of this age still counts. Exponential, half at the half-life. */
export function recencyWeight(observedAt: Date, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - observedAt.getTime()) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

interface Weighted {
  readonly value: number;
  readonly weight: number;
  readonly reviewerId: string;
}

/**
 * Hold every reviewer under `maxShare` of the total weight.
 *
 * Without this, three reviewers is a box the loudest one walks straight
 * through: twenty observations from one person and one each from two others
 * satisfies "three distinct reviewers" while being, in substance, one
 * person's opinion. Capping is water-filling — scaling one reviewer down
 * raises everyone else's share — so it is applied until it settles.
 */
export function capReviewerWeights(rows: readonly Weighted[], maxShare: number): Weighted[] {
  if (maxShare >= 1) return rows.map((r) => ({ ...r }));
  let capped = rows.map((r) => ({ ...r }));
  for (let pass = 0; pass < 12; pass += 1) {
    const total = capped.reduce((a, r) => a + r.weight, 0);
    if (total <= 0) return capped;
    const byReviewer = new Map<string, number>();
    for (const r of capped) byReviewer.set(r.reviewerId, (byReviewer.get(r.reviewerId) ?? 0) + r.weight);
    let changed = false;
    for (const [reviewerId, sum] of byReviewer) {
      if (sum <= 0 || sum / total <= maxShare + 1e-12) continue;
      // Solve for the weight at which this reviewer's share IS the cap:
      //   w / (w + others) = maxShare   =>   w = maxShare/(1 - maxShare) * others.
      // Scaling against the current total instead would undershoot, because
      // shrinking this reviewer shrinks the total they are measured against.
      const others = total - sum;
      const target = (maxShare / (1 - maxShare)) * others;
      const scale = target / sum;
      capped = capped.map((r) => (r.reviewerId === reviewerId ? { ...r, weight: r.weight * scale } : r));
      changed = true;
    }
    if (!changed) break;
  }
  return capped;
}

/**
 * The most rows any one reviewer may contribute to the SAMPLE — as opposed to
 * to the weight.
 *
 * Capping the weight fixed the point estimate and left the confidence interval
 * and the observation count still counting rows, which is most of the problem
 * back again: one reviewer filing eighteen rows, plus two colleagues agreeing
 * once each, produced an interval that excluded zero over twenty "independent"
 * observations. Three reviewers had contributed; one reviewer had decided.
 *
 * So the sample itself is balanced first, and the thresholds are applied to
 * what is left. The cap is the largest `c` for which taking at most `c` rows
 * each still leaves no reviewer above `maxShare` of the result — found by
 * scanning, because `c` appears on both sides.
 */
export function reviewerRowCap(counts: readonly number[], maxShare: number): number {
  if (counts.length === 0) return 0;
  if (maxShare >= 1) return Math.max(...counts);
  let best = 0;
  for (let c = 1; c <= Math.max(...counts); c += 1) {
    const total = counts.reduce((a, n) => a + Math.min(n, c), 0);
    if (c <= maxShare * total + 1e-9) best = c;
    else break;
  }
  return best;
}

/** The weighted median: the value at which half the weight lies either side. */
export function weightedMedian(rows: readonly Weighted[]): number | null {
  const usable = rows.filter((r) => Number.isFinite(r.value) && r.weight > 0);
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((a, r) => a + r.weight, 0);
  const half = total / 2;
  let running = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    running += sorted[i]!.weight;
    if (running > half + 1e-12) return sorted[i]!.value;
    // Exactly half the weight below: the median is the midpoint of this value
    // and the next, the same convention an even-length plain median uses.
    if (Math.abs(running - half) <= 1e-12 && i + 1 < sorted.length) {
      return (sorted[i]!.value + sorted[i + 1]!.value) / 2;
    }
  }
  return sorted[sorted.length - 1]!.value;
}

// ---------------------------------------------------------------------------
// The confidence interval
// ---------------------------------------------------------------------------

/** P(Bin(n, 0.5) <= k), exactly for samples the double can carry, normally beyond. */
function binomialCdfHalf(n: number, k: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (n <= 1000) {
    let pmf = Math.pow(0.5, n);
    let cdf = pmf;
    for (let i = 1; i <= k; i += 1) {
      pmf = (pmf * (n - i + 1)) / i;
      cdf += pmf;
    }
    return Math.min(1, cdf);
  }
  // Normal approximation with a continuity correction. Only reached at sample
  // sizes where it is uncontroversial.
  const mean = n / 2;
  const sd = Math.sqrt(n) / 2;
  const z = (k + 0.5 - mean) / sd;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26; ~1e-7 absolute, far finer than this is used for.
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

export interface MedianInterval {
  readonly low: number;
  readonly high: number;
  readonly confidence: number;
}

/**
 * A distribution-free confidence interval for the median, from the order
 * statistics: the interval is a pair of observed values, so it assumes nothing
 * about the shape of the disagreements — which is the honest choice, because
 * nobody knows that shape.
 *
 * Deliberately UNWEIGHTED. Recency weighting is an opinion about which
 * observations matter more; letting that opinion narrow the interval would let
 * it manufacture the very certainty the interval exists to test. So the point
 * estimate follows recent evidence and the interval is computed over the whole
 * window — a gap that reversed inside the window therefore straddles zero and
 * nothing is applied, which is the right answer.
 *
 * Null when the sample is too small for any interval at this confidence.
 */
export function medianInterval(values: readonly number[], confidence: number): MedianInterval | null {
  const usable = values.filter((v) => Number.isFinite(v));
  const n = usable.length;
  if (n < 2) return null;
  const alphaHalf = (1 - confidence) / 2;
  const sorted = [...usable].sort((a, b) => a - b);
  let k = 0;
  for (let candidate = 1; candidate <= Math.floor(n / 2); candidate += 1) {
    if (binomialCdfHalf(n, candidate - 1) <= alphaHalf) k = candidate;
    else break;
  }
  if (k < 1) return null;
  return { low: sorted[k - 1]!, high: sorted[n - k]!, confidence };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface ReviewerContribution {
  readonly reviewerId: string;
  readonly observations: number;
  /** This reviewer's own median delta — the unit the direction test counts. */
  readonly median: number;
  /** Share of the (capped) weight this reviewer carries. */
  readonly weightShare: number;
}

export interface CalibrationAggregate {
  readonly roleKey: string;
  readonly competencyKey: string;
  readonly competencyId: string;
  readonly band: string;
  /**
   * The paired observations the thresholds are applied to: inside the window,
   * and balanced so no reviewer supplies more than their share (see
   * `reviewerRowCap`). This is also the number the provenance sentence quotes,
   * because it is the number actually behind the adjustment.
   */
  readonly observations: number;
  /** Paired observations inside the window before the sample was balanced. */
  readonly observationsInWindow: number;
  /** Observations seen at all, including those outside the window or unpaired. */
  readonly observationsSeen: number;
  readonly reviewers: number;
  /** The recency-weighted, reviewer-capped median delta. Null when nothing is usable. */
  readonly median: number | null;
  readonly interval: MedianInterval | null;
  /** Reviewers whose own median points the same way as the aggregate, over those with a direction. */
  readonly reviewerAgreement: number;
  readonly contributions: readonly ReviewerContribution[];
  readonly majorDisagreements: number;
  readonly blindObservations: number;
  readonly earliestAt: Date | null;
  readonly latestAt: Date | null;
  /** The reviewers' own words, kept for clustering. Never scored, never judged. */
  readonly reasons: readonly string[];
  /**
   * How many DIFFERENT reviewers wrote any of those words.
   *
   * Not the same as `reviewers`, and the difference matters: three reviewers
   * can disagree with the model while only one of them writes down why. Group
   * that one person's notes into "themes" and you have republished their
   * writing under a heading, attributable by anyone who knows how they write.
   * The clustering floor counts THIS.
   */
  readonly reasonAuthors: number;
}

export interface AggregateInput {
  readonly roleKey: string;
  readonly competencyKey: string;
  readonly competencyId: string;
  readonly band: string;
  readonly observations: readonly CalibrationObservation[];
  readonly now: Date;
  readonly thresholds: CalibrationThresholds;
  /**
   * Reviewers held out of the aggregate while an admin looks at a pattern
   * alert about them. Held out, never discarded: their observations stay on
   * the record and rejoin the moment the alert is closed.
   */
  readonly excludedReviewerIds?: readonly string[];
}

export function aggregate(input: AggregateInput): CalibrationAggregate {
  const { thresholds: t, now } = input;
  const excluded = new Set(input.excludedReviewerIds ?? []);
  const windowStart = new Date(now.getTime() - t.windowDays * DAY_MS);

  const rawInWindow = input.observations.filter(
    (o) => isPaired(o) && !excluded.has(o.reviewerId) && o.observedAt.getTime() >= windowStart.getTime(),
  );

  // Balance the SAMPLE before any threshold touches it, so that "15 paired
  // observations" means fifteen observations no one person supplied most of.
  // Each reviewer keeps their most recent rows; the rest are still on the
  // record, they simply do not get to be counted as independent evidence.
  const inWindow = balanceSample(rawInWindow, t.maxReviewerWeightShare);

  const weighted: Weighted[] = inWindow.map((o) => ({
    value: o.delta as number,
    weight: recencyWeight(o.observedAt, now, t.halfLifeDays),
    reviewerId: o.reviewerId,
  }));
  const capped = capReviewerWeights(weighted, t.maxReviewerWeightShare);
  const median = weightedMedian(capped);
  const interval = medianInterval(inWindow.map((o) => o.delta as number), t.confidence);

  const cappedTotal = capped.reduce((a, r) => a + r.weight, 0) || 1;
  const byReviewer = new Map<string, { deltas: number[]; weight: number }>();
  for (let i = 0; i < inWindow.length; i += 1) {
    const o = inWindow[i]!;
    const entry = byReviewer.get(o.reviewerId) ?? { deltas: [], weight: 0 };
    entry.deltas.push(o.delta as number);
    entry.weight += capped[i]!.weight;
    byReviewer.set(o.reviewerId, entry);
  }
  const contributions: ReviewerContribution[] = [...byReviewer.entries()].map(([reviewerId, e]) => ({
    reviewerId,
    observations: e.deltas.length,
    median: plainMedian(e.deltas),
    weightShare: e.weight / cappedTotal,
  })).sort((a, b) => b.observations - a.observations);

  // Direction is counted per REVIEWER, one vote each, because the question it
  // answers is "do people agree with each other", and one person answering
  // twenty times is still one person.
  const direction = median === null ? 0 : Math.sign(median);
  const withDirection = contributions.filter((c) => Math.sign(c.median) !== 0);
  const agreeing = withDirection.filter((c) => Math.sign(c.median) === direction).length;
  const reviewerAgreement = withDirection.length === 0 ? 0 : agreeing / withDirection.length;

  const withReasons = inWindow.filter((o) => o.reasonText.trim().length > 0);
  const times = inWindow.map((o) => o.observedAt.getTime());
  return {
    roleKey: input.roleKey,
    competencyKey: input.competencyKey,
    competencyId: input.competencyId,
    band: input.band,
    observations: inWindow.length,
    observationsInWindow: rawInWindow.length,
    observationsSeen: input.observations.length,
    reviewers: byReviewer.size,
    median,
    interval,
    reviewerAgreement,
    contributions,
    majorDisagreements: inWindow.filter((o) => magnitudeOf(o.delta) === 'major').length,
    blindObservations: inWindow.filter((o) => o.blindReview).length,
    earliestAt: times.length ? new Date(Math.min(...times)) : null,
    latestAt: times.length ? new Date(Math.max(...times)) : null,
    reasons: withReasons.map((o) => o.reasonText),
    reasonAuthors: new Set(withReasons.map((o) => o.reviewerId)).size,
  };
}

/**
 * Keep at most `reviewerRowCap` rows per reviewer, most recent first.
 *
 * Most recent rather than random: the whole model weights recent evidence more
 * heavily, and a sample that dropped a reviewer's newest rows to keep their
 * oldest would contradict that everywhere else.
 */
function balanceSample(
  observations: readonly CalibrationObservation[], maxShare: number,
): CalibrationObservation[] {
  const byReviewer = new Map<string, CalibrationObservation[]>();
  for (const o of observations) {
    const list = byReviewer.get(o.reviewerId) ?? [];
    list.push(o);
    byReviewer.set(o.reviewerId, list);
  }
  // At least one row each, always. With fewer reviewers than 1/maxShare the
  // cap is arithmetically unsatisfiable — three reviewers can never each hold
  // under a quarter — and returning nothing would make a thin sample look like
  // no sample, losing the counts the admin view reports and the reviewer
  // shortfall the gate below wants to name. One row each is the honest floor:
  // the sample is then genuinely tiny, and the thresholds say so.
  const cap = Math.max(1, reviewerRowCap([...byReviewer.values()].map((list) => list.length), maxShare));
  const kept: CalibrationObservation[] = [];
  for (const list of byReviewer.values()) {
    const newestFirst = [...list].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
    kept.push(...newestFirst.slice(0, cap));
  }
  return kept.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

function plainMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------

/**
 * The measured gap reduced to what may actually be applied: snapped to the
 * step, held inside the bound, and zero when it is smaller than the smallest
 * step the level scale can honestly express.
 */
export function boundDelta(median: number | null, t: CalibrationThresholds): number {
  if (median === null || !Number.isFinite(median)) return 0;
  const snapped = Math.round(median / t.deltaStep) * t.deltaStep;
  const bounded = Math.max(-t.maxAbsDelta, Math.min(t.maxAbsDelta, snapped));
  if (Math.abs(bounded) < t.minAbsDelta - 1e-9) return 0;
  // Snapping can reintroduce float dust; the stored number must read cleanly.
  return Math.round(bounded * 100) / 100;
}

/** A calibrated level, held on the 1..5 scale the rubric is written in. */
export function applyCalibration(level: number, delta: number): number {
  const moved = level + delta;
  return Math.round(Math.min(5, Math.max(1, moved)) * 100) / 100;
}

/** The AI's level as it would be read back on the integer scale, for callers that need one. */
export function nearestProficiency(level: number): Proficiency {
  const rounded = Math.round(Math.min(5, Math.max(0, level)));
  return rounded as Proficiency;
}

// ---------------------------------------------------------------------------
// Fairness
// ---------------------------------------------------------------------------

/**
 * One past assessment, reduced to what a pass-rate projection needs. Read-only
 * input: projecting NEVER writes back, and the assessments it reads are not
 * touched. This is the arithmetic behind the promise that calibration is
 * forward-only.
 */
export interface AssessmentSnapshot {
  readonly assessmentId: string;
  readonly passThreshold: number;
  readonly competencies: ReadonlyArray<{
    readonly id: string;
    readonly level: number | null;
    readonly weight: number;
    readonly notEnoughEvidence: boolean;
  }>;
}

function overallOf(snapshot: AssessmentSnapshot, competencyId: string, delta: number): number | null {
  const scored = snapshot.competencies.filter((c) => !c.notEnoughEvidence && c.level !== null);
  if (scored.length === 0) return null;
  const totalWeight = scored.reduce((a, c) => a + c.weight, 0) || 1;
  const sum = scored.reduce((a, c) => {
    const level = c.id === competencyId ? applyCalibration(c.level as number, delta) : (c.level as number);
    return a + (level / 5) * 100 * c.weight;
  }, 0);
  return sum / totalWeight;
}

export interface PassRateProjection {
  readonly n: number;
  readonly before: number | null;
  readonly after: number | null;
  readonly shift: number | null;
}

/**
 * What this adjustment would have done to the share of assessments reaching
 * the role's pass threshold, replayed over the same window it was learned
 * from.
 *
 * It is a projection and it is stated as one: the replay changes one
 * competency's level and nothing else, so it cannot see how a different level
 * would have changed the interview, the reviewer's reading of it, or the
 * must-pass gates. It exists to catch an adjustment that would visibly move
 * who gets through, which is the failure worth catching.
 */
export function projectPassRate(
  snapshots: readonly AssessmentSnapshot[],
  competencyId: string,
  delta: number,
): PassRateProjection {
  const usable = snapshots.filter((s) => s.competencies.some((c) => c.id === competencyId));
  if (usable.length === 0) return { n: 0, before: null, after: null, shift: null };
  let before = 0;
  let after = 0;
  for (const s of usable) {
    const b = overallOf(s, competencyId, 0);
    const a = overallOf(s, competencyId, delta);
    if (b !== null && b >= s.passThreshold) before += 1;
    if (a !== null && a >= s.passThreshold) after += 1;
  }
  const beforeRate = before / usable.length;
  const afterRate = after / usable.length;
  return {
    n: usable.length,
    before: round4(beforeRate),
    after: round4(afterRate),
    shift: round4(afterRate - beforeRate),
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** How the outcome statistics answered, including "they were not there to ask". */
export type FairnessSource = 'checked' | 'unavailable' | 'insufficient_sample';

export interface FairnessCheck {
  readonly source: FairnessSource;
  readonly projection: PassRateProjection;
  /** What the outcome statistics said about this role, when they were readable. */
  readonly observedPassRate: number | null;
  readonly observedSample: number;
  readonly flagged: boolean;
  readonly statement: string;
}

/**
 * The fairness gate.
 *
 * Calibration learns from people, so it inherits whatever people brought with
 * them. The gate cannot detect bias — nothing here can, and the docs say so —
 * but it can refuse to let an adjustment move who gets through a role without
 * a human being told. When it cannot see the outcome statistics at all it
 * fails CLOSED, because "we could not check" is not "the check passed".
 */
export function evaluateFairness(opts: {
  readonly projection: PassRateProjection;
  readonly observedPassRate: number | null;
  readonly observedSample: number;
  readonly statisticsAvailable: boolean;
  readonly statisticsReadable: boolean;
  readonly thresholds: CalibrationThresholds;
  readonly requireStatistics: boolean;
}): FairnessCheck {
  const { projection, thresholds: t } = opts;
  const shift = projection.shift;
  const movesTooMuch = shift !== null && Math.abs(shift) > t.maxPassRateShift;

  // The replayed projection is checked FIRST, and is checked in every mode.
  //
  // It used to sit below the two branches, so switching the statistics
  // requirement off skipped it as well — and that switch is documented as
  // "check the projection alone", not "check nothing". A projected movement
  // past the limit now holds the adjustment whatever the statistics say or
  // fail to say, which is the only reading of this gate that is always safe.
  if (movesTooMuch) {
    return {
      source: opts.statisticsAvailable ? (opts.statisticsReadable ? 'checked' : 'insufficient_sample') : 'unavailable',
      projection,
      observedPassRate: opts.observedPassRate,
      observedSample: opts.observedSample,
      flagged: true,
      statement: `Held: replayed over the same interviews, this adjustment would move the share reaching the pass threshold by ${formatShift(shift as number)} — more than the ${Math.round(t.maxPassRateShift * 100)}% this check allows without a person looking first.`,
    };
  }

  if (!opts.statisticsAvailable) {
    return {
      source: 'unavailable',
      projection,
      observedPassRate: null,
      observedSample: 0,
      flagged: opts.requireStatistics,
      statement: opts.requireStatistics
        ? 'Held: the outcome statistics this check reads were not available, so the effect on this role\'s pass rates could not be checked. Nothing was applied.'
        : 'The outcome statistics were not available, so only the replayed projection was checked.',
    };
  }
  if (!opts.statisticsReadable) {
    // A sample too small to read is the same situation as no statistics at
    // all: the check could not be made. It is treated the same way, and the
    // same deployment switch governs both.
    return {
      source: 'insufficient_sample',
      projection,
      observedPassRate: opts.observedPassRate,
      observedSample: opts.observedSample,
      flagged: opts.requireStatistics,
      statement: opts.requireStatistics
        ? `Held: this role has ${opts.observedSample} outcomes on record, too few for the pass-rate statistics to say anything. Nothing was applied.`
        : `This role has ${opts.observedSample} outcomes on record, too few for the pass-rate statistics to say anything, so only the replayed projection was checked.`,
    };
  }
  if (movesTooMuch) {
    return {
      source: 'checked',
      projection,
      observedPassRate: opts.observedPassRate,
      observedSample: opts.observedSample,
      flagged: true,
      statement: `Held: replayed over the same interviews, this adjustment would move the share reaching the pass threshold by ${formatShift(shift as number)} — more than the ${Math.round(t.maxPassRateShift * 100)}% this check allows without a person looking first.`,
    };
  }
  return {
    source: 'checked',
    projection,
    observedPassRate: opts.observedPassRate,
    observedSample: opts.observedSample,
    flagged: false,
    statement: shift === null
      ? 'No past assessment on this role used this competency, so there was nothing to replay; the outcome statistics were readable and showed no flag.'
      : `Replayed over ${projection.n} past assessments, this adjustment moves the share reaching the pass threshold by ${formatShift(shift)}.`,
  };
}

function formatShift(shift: number): string {
  const pct = Math.round(Math.abs(shift) * 1000) / 10;
  if (pct === 0) return 'nothing measurable';
  return `${shift > 0 ? '+' : '-'}${pct} percentage points`;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export type ActivationOutcome = 'activate' | 'hold' | 'nothing_to_apply';

export type HoldReason =
  | 'too_few_observations'
  | 'too_few_reviewers'
  | 'no_interval'
  | 'interval_includes_zero'
  | 'estimate_outside_interval'
  | 'reviewers_disagree'
  | 'below_smallest_step'
  | 'fairness_flagged'
  | 'switched_off';

export interface ActivationDecision {
  readonly outcome: ActivationOutcome;
  readonly delta: number;
  readonly reason: HoldReason | null;
  /** Said in plain words, for the admin view, the alert and the audit trail. */
  readonly statement: string;
  readonly provenance: string;
}

export interface ActivationInput {
  readonly aggregate: CalibrationAggregate;
  readonly thresholds: CalibrationThresholds;
  readonly fairness: FairnessCheck;
  readonly enabled: boolean;
}

/**
 * The gate. Every condition is checked in the order a person would ask them,
 * and the FIRST failure is the one reported — a list of everything wrong tells
 * an admin less than the one thing standing in the way.
 */
export function decideActivation(input: ActivationInput): ActivationDecision {
  const { aggregate: agg, thresholds: t, fairness } = input;
  const provenance = describeProvenance(agg);

  if (!input.enabled) {
    return hold('switched_off', 'Calibration is switched off, so nothing was applied.', 0, provenance);
  }
  if (agg.observations === 0) {
    return hold(
      'too_few_observations',
      'No reviewer has yet recorded a level for this competency that the model also graded, so there is nothing to compare.',
      0, provenance,
    );
  }
  // Reviewers before observations, because the sample is balanced per reviewer
  // (see `balanceSample`): with too few people the row count collapses, and
  // "too few reviews" would then be a true sentence that names the wrong
  // problem. The number of people is the thing to fix.
  if (agg.reviewers < t.minReviewers) {
    return hold(
      'too_few_reviewers',
      `Only ${agg.reviewers} reviewer${agg.reviewers === 1 ? '' : 's'} contributed; ${t.minReviewers} are needed so that no one person can move a role's scoring.`,
      0, provenance,
    );
  }
  if (agg.observations < t.minObservations) {
    return hold(
      'too_few_observations',
      `Too few reviews to say anything: ${agg.observations} of the ${t.minObservations} paired reviews needed${agg.observationsInWindow > agg.observations ? `, counting at most a fair share from each reviewer (${agg.observationsInWindow} reviews in all)` : ''}.`,
      0, provenance,
    );
  }
  if (!agg.interval) {
    return hold('no_interval', 'The sample is too small for a confidence interval on the median, so the gap cannot be told apart from noise.', 0, provenance);
  }
  if (agg.interval.low <= 0 && agg.interval.high >= 0) {
    return hold(
      'interval_includes_zero',
      `The gap's ${Math.round(agg.interval.confidence * 100)}% interval runs from ${fmt(agg.interval.low)} to ${fmt(agg.interval.high)} and includes zero, so there is no systematic gap to correct.`,
      0, provenance,
    );
  }
  // The point estimate is recency-weighted and reviewer-capped; the interval is
  // neither. When they point opposite ways, the recent reviewer-balanced reading
  // and the sample as a whole are telling two different stories — most often
  // because one person filed most of the rows. There is no honest way to pick a
  // winner, so nothing is applied.
  if (agg.median !== null && Math.sign(agg.median) !== 0 && Math.sign(agg.interval.low) !== Math.sign(agg.median)) {
    return hold(
      'estimate_outside_interval',
      `The reviewer-balanced estimate (${fmt(agg.median)}) and the interval (${fmt(agg.interval.low)} to ${fmt(agg.interval.high)}) point different ways. Weighting reviewers equally gives a different answer from counting every review, so there is no settled gap to apply.`,
      0, provenance,
    );
  }
  if (agg.reviewerAgreement < t.minReviewerAgreement) {
    return hold(
      'reviewers_disagree',
      `Reviewers do not point the same way: ${Math.round(agg.reviewerAgreement * 100)}% of those with a direction agree, below the ${Math.round(t.minReviewerAgreement * 100)}% needed. A gap only some reviewers see is not the role's gap.`,
      0, provenance,
    );
  }

  const delta = boundDelta(agg.median, t);
  if (delta === 0) {
    return {
      outcome: 'nothing_to_apply',
      delta: 0,
      reason: 'below_smallest_step',
      statement: `A gap of ${fmt(agg.median ?? 0)} levels was measured and is smaller than the ${t.minAbsDelta}-level step the scale can express, so it is recorded and not applied.`,
      provenance,
    };
  }
  if (fairness.flagged) {
    return hold('fairness_flagged', fairness.statement, 0, provenance);
  }

  return {
    outcome: 'activate',
    delta,
    reason: null,
    statement: `Adjusted ${fmt(delta)}: ${provenance}.`,
    provenance,
  };
}

function hold(reason: HoldReason, statement: string, delta: number, provenance: string): ActivationDecision {
  return { outcome: 'hold', delta, reason, statement, provenance };
}

function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/**
 * The sentence the owner asked for, and it is the whole justification a score
 * movement ever gets: how many reviews, how many reviewers, since when.
 */
export function describeProvenance(
  agg: Pick<CalibrationAggregate, 'observations' | 'reviewers' | 'earliestAt'>,
): string {
  const since = agg.earliestAt ? formatDay(agg.earliestAt) : 'an unrecorded date';
  const reviews = `${agg.observations} review${agg.observations === 1 ? '' : 's'}`;
  const reviewers = `${agg.reviewers} reviewer${agg.reviewers === 1 ? '' : 's'}`;
  return `${reviews}, ${reviewers}, since ${since}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// What an assessment carries
// ---------------------------------------------------------------------------

/**
 * The provenance recorded on every calibrated competency of every assessment,
 * so a score movement can be reconstructed years later from the assessment
 * alone — without the adjustment row, which may since have been reverted.
 *
 * Defined with the assessment's own types, because that is where it is stored
 * and there must be exactly one shape for it.
 */
export type CalibrationProvenance = CompetencyCalibrationNote;

/** The adjustment the evaluator is handed, per competency id. */
export interface CompetencyCalibration {
  readonly delta: number;
  readonly provenance: CalibrationProvenance;
}

export type CalibrationMap = Readonly<Record<string, CompetencyCalibration>>;
