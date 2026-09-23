import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CALIBRATION_THRESHOLDS, aggregate, applyCalibration, boundDelta, capReviewerWeights,
  competencyKeyOf, decideActivation, describeProvenance, evaluateFairness, isShareableRoleKey,
  magnitudeOf, medianInterval, projectPassRate, recencyWeight, resolveThresholds, roleKeyOf,
  weightedMedian, type AssessmentSnapshot, type CalibrationObservation, type CalibrationThresholds,
  type FairnessCheck,
} from '../src/domain/calibration.js';

const NOW = new Date('2026-09-23T00:00:00.000Z');
const T = DEFAULT_CALIBRATION_THRESHOLDS;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function obs(p: Partial<CalibrationObservation> & { reviewerId: string; delta: number | null }): CalibrationObservation {
  const ai = 3;
  return {
    reviewId: p.reviewId ?? `r-${Math.random().toString(36).slice(2)}`,
    reviewerId: p.reviewerId,
    competencyId: p.competencyId ?? 'c1',
    competencyKey: p.competencyKey ?? 'stakeholder management',
    aiLevel: p.aiLevel ?? ai,
    humanLevel: p.delta === null ? null : ai + p.delta,
    delta: p.delta,
    observedAt: p.observedAt ?? daysAgo(10),
    reasonText: p.reasonText ?? '',
    blindReview: p.blindReview ?? false,
  };
}

/** n observations of the same delta, spread evenly across the reviewers given. */
function fixture(deltas: readonly number[], reviewers: readonly string[], ageDays = 10): CalibrationObservation[] {
  return deltas.map((delta, i) => obs({
    reviewerId: reviewers[i % reviewers.length]!,
    delta,
    reviewId: `r${i}`,
    observedAt: daysAgo(ageDays),
  }));
}

function agg(observations: readonly CalibrationObservation[], thresholds: CalibrationThresholds = T) {
  return aggregate({
    roleKey: 'catalog:backend-engineer',
    competencyKey: 'stakeholder management',
    competencyId: 'c1',
    band: 'mid',
    observations,
    now: NOW,
    thresholds,
  });
}

const CLEAN_FAIRNESS: FairnessCheck = {
  source: 'checked',
  projection: { n: 20, before: 0.5, after: 0.48, shift: -0.02 },
  observedPassRate: 0.5,
  observedSample: 40,
  flagged: false,
  statement: 'fine',
};

// ---------------------------------------------------------------------------
// Keys and shapes
// ---------------------------------------------------------------------------

describe('keys', () => {
  it('reduces a competency name to one spelling per organisation', () => {
    expect(competencyKeyOf('  Vendor   Management ')).toBe('vendor management');
  });

  it('keys a catalog role on the shared catalog id so organisations can pool evidence', () => {
    expect(roleKeyOf({ catalogRoleId: 'cat_be1', roleId: 'x' })).toBe('catalog:cat_be1');
  });

  it('keys a role outside the catalog on its own id, which can never be shared', () => {
    const key = roleKeyOf({ catalogRoleId: null, roleId: 'role_123' });
    expect(key).toBe('role:role_123');
    expect(isShareableRoleKey(key)).toBe(false);
  });

  it('tells a loud disagreement from a quiet one', () => {
    expect(magnitudeOf(0)).toBe('none');
    expect(magnitudeOf(null)).toBe('none');
    expect(magnitudeOf(-1)).toBe('minor');
    expect(magnitudeOf(2)).toBe('major');
    expect(magnitudeOf(-3)).toBe('major');
  });
});

describe('resolveThresholds', () => {
  it('never lets an organisation loosen the one-level bound', () => {
    expect(resolveThresholds({ maxAbsDelta: 4 }).maxAbsDelta).toBe(1);
  });

  it('lets an organisation make the evidence bar higher', () => {
    expect(resolveThresholds({ minObservations: 50 }).minObservations).toBe(50);
  });

  it('never lets the distinct-reviewer floor go below three', () => {
    expect(resolveThresholds({ minReviewers: 1 }).minReviewers).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Weighting
// ---------------------------------------------------------------------------

describe('recency weighting', () => {
  it('counts an observation at the half-life as half', () => {
    expect(recencyWeight(daysAgo(180), NOW, 180)).toBeCloseTo(0.5, 6);
  });

  it('counts today fully', () => {
    expect(recencyWeight(NOW, NOW, 180)).toBe(1);
  });
});

describe('capReviewerWeights', () => {
  it('holds one loud reviewer under the share cap', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => ({ value: -1, weight: 1, reviewerId: 'loud' })),
      { value: 1, weight: 1, reviewerId: 'b' },
      { value: 1, weight: 1, reviewerId: 'c' },
    ];
    const capped = capReviewerWeights(rows, 0.4);
    const total = capped.reduce((a, r) => a + r.weight, 0);
    const loud = capped.filter((r) => r.reviewerId === 'loud').reduce((a, r) => a + r.weight, 0);
    expect(loud / total).toBeCloseTo(0.4, 6);
  });

  it('leaves balanced contributions alone', () => {
    const rows = [
      { value: 1, weight: 1, reviewerId: 'a' },
      { value: 1, weight: 1, reviewerId: 'b' },
      { value: 1, weight: 1, reviewerId: 'c' },
    ];
    expect(capReviewerWeights(rows, 0.4).every((r) => r.weight === 1)).toBe(true);
  });
});

describe('weightedMedian', () => {
  it('is the plain median when the weights are equal', () => {
    const rows = [1, 2, 3, 4, 5].map((value) => ({ value, weight: 1, reviewerId: 'a' }));
    expect(weightedMedian(rows)).toBe(3);
  });

  it('follows the weight, not the count', () => {
    const rows = [
      { value: -1, weight: 10, reviewerId: 'a' },
      { value: 1, weight: 1, reviewerId: 'b' },
      { value: 1, weight: 1, reviewerId: 'c' },
    ];
    expect(weightedMedian(rows)).toBe(-1);
  });

  it('is null when there is nothing to take a median of', () => {
    expect(weightedMedian([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The interval
// ---------------------------------------------------------------------------

describe('medianInterval', () => {
  it('gives no interval at all for a sample too small to have one', () => {
    expect(medianInterval([-1, -1, -1], 0.95)).toBeNull();
  });

  it('excludes zero when every reviewer moved the same way', () => {
    const interval = medianInterval(Array.from({ length: 15 }, () => -1), 0.95);
    expect(interval).not.toBeNull();
    expect(interval!.high).toBeLessThan(0);
  });

  it('includes zero when the disagreements point both ways', () => {
    const values = [...Array.from({ length: 8 }, () => -1), ...Array.from({ length: 7 }, () => 1)];
    const interval = medianInterval(values, 0.95);
    expect(interval).not.toBeNull();
    expect(interval!.low).toBeLessThanOrEqual(0);
    expect(interval!.high).toBeGreaterThanOrEqual(0);
  });

  it('stays finite on a large sample, where the approximation takes over', () => {
    const interval = medianInterval(Array.from({ length: 5000 }, () => -1), 0.95);
    expect(interval).toEqual({ low: -1, high: -1, confidence: 0.95 });
  });
});

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------

describe('boundDelta', () => {
  it('never exceeds one level however large the measured gap', () => {
    expect(boundDelta(-3.4, T)).toBe(-1);
    expect(boundDelta(9, T)).toBe(1);
  });

  it('snaps to the half-level step', () => {
    expect(boundDelta(-0.6, T)).toBe(-0.5);
    expect(boundDelta(-0.8, T)).toBe(-1);
  });

  it('applies nothing below the smallest step the scale can express', () => {
    expect(boundDelta(-0.2, T)).toBe(0);
    expect(boundDelta(null, T)).toBe(0);
  });
});

describe('applyCalibration', () => {
  it('moves a level by the adjustment', () => {
    expect(applyCalibration(4, -0.5)).toBe(3.5);
  });

  it('never leaves the 1..5 scale the rubric is written in', () => {
    expect(applyCalibration(5, 1)).toBe(5);
    expect(applyCalibration(1, -1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Aggregation fixtures
// ---------------------------------------------------------------------------

describe('aggregate', () => {
  it('no evidence: reports nothing rather than zero', () => {
    const a = agg([]);
    expect(a.observations).toBe(0);
    expect(a.reviewers).toBe(0);
    expect(a.median).toBeNull();
    expect(a.interval).toBeNull();
  });

  it('thin evidence: counts what there is and produces no interval', () => {
    const a = agg(fixture([-1, -1, -1], ['a', 'b', 'c']));
    expect(a.observations).toBe(3);
    expect(a.reviewers).toBe(3);
    expect(a.interval).toBeNull();
  });

  it('a clear systematic gap: median and interval both point one way', () => {
    const a = agg(fixture(Array.from({ length: 18 }, () => -1), ['a', 'b', 'c', 'd']));
    expect(a.observations).toBe(18);
    expect(a.reviewers).toBe(4);
    expect(a.median).toBe(-1);
    expect(a.interval!.high).toBeLessThan(0);
    expect(a.reviewerAgreement).toBe(1);
  });

  it('one loud reviewer cannot carry more than the share cap', () => {
    const loud = Array.from({ length: 20 }, (_, i) => obs({ reviewerId: 'loud', delta: -2, reviewId: `l${i}` }));
    const others = [obs({ reviewerId: 'b', delta: 0, reviewId: 'b1' }), obs({ reviewerId: 'c', delta: 0, reviewId: 'c1' })];
    const a = agg([...loud, ...others]);
    const loudShare = a.contributions.find((c) => c.reviewerId === 'loud')!.weightShare;
    expect(loudShare).toBeCloseTo(0.4, 6);
  });

  it('ignores observations outside the window', () => {
    const inside = fixture(Array.from({ length: 5 }, () => -1), ['a', 'b', 'c'], 10);
    const outside = fixture(Array.from({ length: 30 }, () => -1), ['a', 'b', 'c'], 900);
    const a = agg([...inside, ...outside]);
    expect(a.observations).toBe(5);
    expect(a.observationsSeen).toBe(35);
  });

  it('holds out an excluded reviewer without losing the record of them', () => {
    const observations = [
      ...Array.from({ length: 10 }, (_, i) => obs({ reviewerId: 'flagged', delta: -2, reviewId: `f${i}` })),
      ...Array.from({ length: 4 }, (_, i) => obs({ reviewerId: 'b', delta: 0, reviewId: `b${i}` })),
    ];
    const a = aggregate({
      roleKey: 'catalog:x', competencyKey: 'k', competencyId: 'c1', band: 'mid',
      observations, now: NOW, thresholds: T, excludedReviewerIds: ['flagged'],
    });
    expect(a.observations).toBe(4);
    expect(a.observationsSeen).toBe(14);
    expect(a.contributions.some((c) => c.reviewerId === 'flagged')).toBe(false);
  });

  it('keeps the reviewers own words, unjudged, for clustering', () => {
    const a = agg([obs({ reviewerId: 'a', delta: -1, reasonText: 'They named the trade-off; the AI missed it.' })]);
    expect(a.reasons).toEqual(['They named the trade-off; the AI missed it.']);
  });

  it('counts the reviewers who WROTE, not the reviewers who disagreed', () => {
    // Three reviewers disagree; only one of them writes anything down.
    // Clustering one person's notes into "themes" republishes their words.
    const a = agg([
      obs({ reviewerId: 'a', delta: -1, reviewId: '1', reasonText: 'A strong answer names the outcome.' }),
      obs({ reviewerId: 'a', delta: -1, reviewId: '2', reasonText: 'Again, no outcome given.' }),
      obs({ reviewerId: 'a', delta: -1, reviewId: '3', reasonText: 'No measurable result anywhere.' }),
      obs({ reviewerId: 'b', delta: -1, reviewId: '4' }),
      obs({ reviewerId: 'c', delta: -1, reviewId: '5' }),
    ]);
    expect(a.reviewers).toBe(3);
    expect(a.reasonAuthors).toBe(1);
    expect(a.reasons).toHaveLength(3);
  });

  it('counts each writer once however much they wrote', () => {
    const a = agg([
      obs({ reviewerId: 'a', delta: -1, reviewId: '1', reasonText: 'One.' }),
      obs({ reviewerId: 'b', delta: -1, reviewId: '2', reasonText: 'Two.' }),
      obs({ reviewerId: 'b', delta: -1, reviewId: '3', reasonText: 'Three.' }),
    ]);
    expect(a.reasonAuthors).toBe(2);
  });

  it('counts major disagreements apart from minor ones', () => {
    const a = agg([
      obs({ reviewerId: 'a', delta: -2, reviewId: '1' }),
      obs({ reviewerId: 'b', delta: -1, reviewId: '2' }),
    ]);
    expect(a.majorDisagreements).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The activation gate
// ---------------------------------------------------------------------------

describe('decideActivation', () => {
  const decide = (observations: readonly CalibrationObservation[], fairness = CLEAN_FAIRNESS, enabled = true) =>
    decideActivation({ aggregate: agg(observations), thresholds: T, fairness, enabled });

  it('no evidence: holds and says how far off it is', () => {
    const d = decide([]);
    expect(d.outcome).toBe('hold');
    expect(d.reason).toBe('too_few_observations');
    expect(d.delta).toBe(0);
    expect(d.statement).toContain('Too few reviews');
  });

  it('thin evidence: holds on the observation count before anything else', () => {
    const d = decide(fixture([-1, -1, -1, -1, -1], ['a', 'b', 'c']));
    expect(d.reason).toBe('too_few_observations');
  });

  it('enough observations but too few reviewers: holds', () => {
    const d = decide(fixture(Array.from({ length: 20 }, () => -1), ['a', 'b']));
    expect(d.outcome).toBe('hold');
    expect(d.reason).toBe('too_few_reviewers');
  });

  it('one loud reviewer plus two quiet ones: holds because reviewers do not point the same way', () => {
    const observations = [
      ...Array.from({ length: 20 }, (_, i) => obs({ reviewerId: 'loud', delta: -2, reviewId: `l${i}` })),
      obs({ reviewerId: 'b', delta: 1, reviewId: 'b1' }),
      obs({ reviewerId: 'c', delta: 1, reviewId: 'c1' }),
    ];
    const d = decide(observations);
    expect(d.outcome).toBe('hold');
    expect(['reviewers_disagree', 'interval_includes_zero', 'estimate_outside_interval']).toContain(d.reason);
    expect(d.delta).toBe(0);
  });

  it('conflicting reviewers: holds because the interval includes zero', () => {
    const observations = [
      ...Array.from({ length: 9 }, (_, i) => obs({ reviewerId: 'a', delta: -1, reviewId: `a${i}` })),
      ...Array.from({ length: 9 }, (_, i) => obs({ reviewerId: 'b', delta: 1, reviewId: `b${i}` })),
      ...Array.from({ length: 4 }, (_, i) => obs({ reviewerId: 'c', delta: 0, reviewId: `c${i}` })),
    ];
    const d = decide(observations);
    expect(d.outcome).toBe('hold');
    expect(['interval_includes_zero', 'reviewers_disagree']).toContain(d.reason);
  });

  it('a gap that reverses over time: the interval straddles zero, so nothing is applied', () => {
    const early = Array.from({ length: 12 }, (_, i) => obs({ reviewerId: ['a', 'b', 'c'][i % 3]!, delta: -1, reviewId: `e${i}`, observedAt: daysAgo(300) }));
    const late = Array.from({ length: 12 }, (_, i) => obs({ reviewerId: ['a', 'b', 'c'][i % 3]!, delta: 1, reviewId: `t${i}`, observedAt: daysAgo(5) }));
    const a = agg([...early, ...late]);
    // Recency pulls the point estimate towards the recent direction...
    expect(a.median).toBeGreaterThan(0);
    // ...and the unweighted interval refuses to call it.
    const d = decideActivation({ aggregate: a, thresholds: T, fairness: CLEAN_FAIRNESS, enabled: true });
    expect(d.outcome).toBe('hold');
    expect(d.delta).toBe(0);
  });

  it('a clear systematic gap: activates, bounded, with the provenance the owner asked for', () => {
    const d = decide(fixture(Array.from({ length: 18 }, () => -1), ['a', 'b', 'c', 'd']));
    expect(d.outcome).toBe('activate');
    expect(d.delta).toBe(-1);
    expect(d.statement).toMatch(/^Adjusted -1: 18 reviews, 4 reviewers, since /);
  });

  it('a gap larger than a level is still only ever one level', () => {
    const d = decide(fixture(Array.from({ length: 20 }, () => -3), ['a', 'b', 'c', 'd']));
    expect(d.outcome).toBe('activate');
    expect(d.delta).toBe(-1);
  });

  it('a measured gap below the smallest step is recorded and not applied', () => {
    // Half the sample at -1 and half at 0 gives a median of about -0.5 by weight,
    // but with an interval that excludes zero only when the negatives dominate.
    const observations = [
      ...Array.from({ length: 14 }, (_, i) => obs({ reviewerId: ['a', 'b', 'c'][i % 3]!, delta: -1, reviewId: `n${i}` })),
      ...Array.from({ length: 13 }, (_, i) => obs({ reviewerId: ['a', 'b', 'c'][i % 3]!, delta: 0, reviewId: `z${i}` })),
    ];
    const a = agg(observations);
    const d = decideActivation({ aggregate: a, thresholds: T, fairness: CLEAN_FAIRNESS, enabled: true });
    // Either it is held (interval includes zero) or it is measured-and-not-applied;
    // what must never happen is a score moving on this evidence.
    expect(d.delta).toBe(0);
  });

  it('a flagged fairness check holds an otherwise-passing calibration', () => {
    const flagged: FairnessCheck = { ...CLEAN_FAIRNESS, flagged: true, statement: 'Held: pass rates move too far.' };
    const d = decide(fixture(Array.from({ length: 18 }, () => -1), ['a', 'b', 'c', 'd']), flagged);
    expect(d.outcome).toBe('hold');
    expect(d.reason).toBe('fairness_flagged');
    expect(d.delta).toBe(0);
  });

  it('the kill switch holds everything, whatever the evidence says', () => {
    const d = decide(fixture(Array.from({ length: 40 }, () => -1), ['a', 'b', 'c', 'd']), CLEAN_FAIRNESS, false);
    expect(d.outcome).toBe('hold');
    expect(d.reason).toBe('switched_off');
    expect(d.delta).toBe(0);
  });

  it('never describes a reviewer as wrong', () => {
    const cases = [
      decide([]),
      decide(fixture(Array.from({ length: 20 }, () => -1), ['a', 'b'])),
      decide(fixture(Array.from({ length: 18 }, () => -1), ['a', 'b', 'c', 'd'])),
    ];
    for (const d of cases) {
      expect(d.statement.toLowerCase()).not.toMatch(/wrong|incorrect|mistake|error by|too harsh|too lenient|bias/);
    }
  });
});

describe('describeProvenance', () => {
  it('says how many reviews, how many reviewers, and since when', () => {
    const a = agg(fixture(Array.from({ length: 18 }, () => -1), ['a', 'b', 'c', 'd']));
    expect(describeProvenance(a)).toBe('18 reviews, 4 reviewers, since 13 Sep 2026');
  });
});

// ---------------------------------------------------------------------------
// Fairness
// ---------------------------------------------------------------------------

describe('projectPassRate', () => {
  const snapshot = (levels: Record<string, number>): AssessmentSnapshot => ({
    assessmentId: `a-${Math.random()}`,
    passThreshold: 70,
    competencies: Object.entries(levels).map(([id, level]) => ({ id, level, weight: 0.5, notEnoughEvidence: false })),
  });

  it('is empty when no past assessment used the competency', () => {
    expect(projectPassRate([snapshot({ other: 4 })], 'c1', -1)).toEqual({ n: 0, before: null, after: null, shift: null });
  });

  it('measures how far the pass rate would move', () => {
    // Both at level 4 => 80; dropping c1 a level => (60 + 80)/2 = 70, still at the threshold.
    const snapshots = [snapshot({ c1: 4, c2: 4 }), snapshot({ c1: 3, c2: 3 })];
    const projection = projectPassRate(snapshots, 'c1', -1);
    expect(projection.n).toBe(2);
    expect(projection.before).toBe(0.5);
    expect(projection.after).toBe(0.5);
    expect(projection.shift).toBe(0);
  });

  it('sees a movement that pushes assessments under the threshold', () => {
    const snapshots = Array.from({ length: 4 }, () => snapshot({ c1: 4, c2: 3 }));
    // before: (80 + 60)/2 = 70 -> pass. after -1: (60 + 60)/2 = 60 -> fail.
    const projection = projectPassRate(snapshots, 'c1', -1);
    expect(projection.before).toBe(1);
    expect(projection.after).toBe(0);
    expect(projection.shift).toBe(-1);
  });

  it('never touches the snapshots it reads', () => {
    const snapshots = [snapshot({ c1: 4, c2: 4 })];
    const before = JSON.stringify(snapshots);
    projectPassRate(snapshots, 'c1', -1);
    expect(JSON.stringify(snapshots)).toBe(before);
  });
});

describe('evaluateFairness', () => {
  const base = {
    projection: { n: 20, before: 0.5, after: 0.48, shift: -0.02 },
    observedPassRate: 0.5,
    observedSample: 40,
    thresholds: T,
  };

  it('fails closed when the outcome statistics are not there to ask', () => {
    const check = evaluateFairness({ ...base, statisticsAvailable: false, statisticsReadable: false, requireStatistics: true });
    expect(check.source).toBe('unavailable');
    expect(check.flagged).toBe(true);
    expect(check.statement).toContain('Held');
  });

  it('can be told not to require the statistics, and then says so', () => {
    const check = evaluateFairness({ ...base, statisticsAvailable: false, statisticsReadable: false, requireStatistics: false });
    expect(check.flagged).toBe(false);
  });

  it('still checks the replayed projection when the statistics are not required', () => {
    // The switch means "check the projection alone", not "check nothing".
    const check = evaluateFairness({
      ...base, projection: { n: 20, before: 0.5, after: 0.2, shift: -0.3 },
      statisticsAvailable: false, statisticsReadable: false, requireStatistics: false,
    });
    expect(check.flagged).toBe(true);
    expect(check.statement).toContain('percentage points');
  });

  it('still checks the replayed projection when the sample is too small to read', () => {
    const check = evaluateFairness({
      ...base, projection: { n: 20, before: 0.5, after: 0.9, shift: 0.4 }, observedSample: 3,
      statisticsAvailable: true, statisticsReadable: false, requireStatistics: false,
    });
    expect(check.flagged).toBe(true);
  });

  it('holds when the role has too few outcomes for the statistics to mean anything', () => {
    const check = evaluateFairness({ ...base, observedSample: 3, statisticsAvailable: true, statisticsReadable: false, requireStatistics: true });
    expect(check.source).toBe('insufficient_sample');
    expect(check.flagged).toBe(true);
  });

  it('holds when the projected pass rate moves further than allowed', () => {
    const check = evaluateFairness({
      ...base, projection: { n: 20, before: 0.5, after: 0.2, shift: -0.3 },
      statisticsAvailable: true, statisticsReadable: true, requireStatistics: true,
    });
    expect(check.flagged).toBe(true);
    expect(check.statement).toContain('percentage points');
  });

  it('passes a small, checked movement', () => {
    const check = evaluateFairness({ ...base, statisticsAvailable: true, statisticsReadable: true, requireStatistics: true });
    expect(check.flagged).toBe(false);
    expect(check.source).toBe('checked');
  });
});
