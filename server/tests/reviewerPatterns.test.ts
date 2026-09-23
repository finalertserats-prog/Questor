import { describe, it, expect } from 'vitest';
import { DEFAULT_CALIBRATION_THRESHOLDS } from '../src/domain/calibration.js';
import {
  NEVER_SAY, heldOutReviewers, organisationBaseline, patternAlerts, peerGaps, proportion,
  reviewerStatistics, type PeerLevel, type ReviewRecord,
} from '../src/domain/reviewerPatterns.js';

const T = DEFAULT_CALIBRATION_THRESHOLDS;

function review(p: Partial<ReviewRecord> & { reviewerId: string }): ReviewRecord {
  return {
    reviewId: p.reviewId ?? `rv-${Math.random().toString(36).slice(2)}`,
    reviewerId: p.reviewerId,
    assessmentId: p.assessmentId ?? 'a1',
    roleKey: p.roleKey ?? 'catalog:backend-engineer',
    aiVerdict: p.aiVerdict ?? 'PROCEED',
    humanVerdict: p.humanVerdict ?? 'PROCEED',
    agreedWithAi: p.agreedWithAi ?? true,
    overridesDown: p.overridesDown ?? 0,
    overridesUp: p.overridesUp ?? 0,
    competencyCount: p.competencyCount ?? 6,
    overridesWithReason: p.overridesWithReason ?? 0,
    reasonChars: p.reasonChars ?? 120,
    secondsToRecord: p.secondsToRecord === undefined ? 300 : p.secondsToRecord,
    recordedAt: p.recordedAt ?? new Date('2026-09-01T00:00:00.000Z'),
    blindReview: p.blindReview ?? false,
  };
}

function many(n: number, p: Partial<ReviewRecord> & { reviewerId: string }): ReviewRecord[] {
  return Array.from({ length: n }, (_, i) => review({ ...p, reviewId: `${p.reviewerId}-${i}` }));
}

describe('proportion', () => {
  it('never reports a bound outside 0..1', () => {
    const p = proportion(0, 12);
    expect(p.low).toBeGreaterThanOrEqual(0);
    expect(p.high).toBeLessThanOrEqual(1);
  });

  it('is wide on a small sample and narrow on a large one', () => {
    const small = proportion(5, 10);
    const large = proportion(500, 1000);
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });

  it('says nothing at all about an empty sample', () => {
    expect(proportion(0, 0)).toEqual({ count: 0, n: 0, value: 0, low: 0, high: 1 });
  });
});

describe('reviewerStatistics', () => {
  it('refuses to say anything below the minimum number of reviews', () => {
    const stats = reviewerStatistics('a', many(9, { reviewerId: 'a' }), undefined, T);
    expect(stats.tooFewToSay).toBe(true);
    expect(stats.reviews).toBe(9);
    expect(stats.minimumReviews).toBe(10);
    expect(stats.divergenceFromAi).toBeNull();
    expect(stats.verdictMix).toBeNull();
  });

  it('computes the figures once there are enough reviews', () => {
    const reviews = [
      ...many(6, { reviewerId: 'a', agreedWithAi: false, humanVerdict: 'DO_NOT_PROGRESS', overridesDown: 2, overridesWithReason: 2 }),
      ...many(6, { reviewerId: 'a' }),
    ];
    const stats = reviewerStatistics('a', reviews, undefined, T);
    expect(stats.tooFewToSay).toBe(false);
    expect(stats.reviews).toBe(12);
    expect(stats.divergenceFromAi!.value).toBe(0.5);
    expect(stats.verdictMix!.DO_NOT_PROGRESS!.value).toBe(0.5);
    expect(stats.overridesTotal).toBe(12);
    expect(stats.downwardShare!.value).toBe(1);
    expect(stats.reasonGiven!.value).toBe(1);
  });

  it('reports timing as unknown rather than guessing it', () => {
    const stats = reviewerStatistics('a', many(12, { reviewerId: 'a', secondsToRecord: null }), undefined, T);
    expect(stats.medianSecondsToRecord).toBeNull();
    expect(stats.timingKnownFor).toBe(0);
  });

  it('counts only this reviewer', () => {
    const reviews = [...many(12, { reviewerId: 'a' }), ...many(30, { reviewerId: 'b' })];
    expect(reviewerStatistics('a', reviews, undefined, T).reviews).toBe(12);
  });
});

describe('peerGaps', () => {
  it('compares a reviewer with colleagues, never with themselves', () => {
    const rows: PeerLevel[] = [
      { reviewerId: 'a', roleKey: 'r', competencyKey: 'c', band: 'mid', level: 2 },
      { reviewerId: 'b', roleKey: 'r', competencyKey: 'c', band: 'mid', level: 4 },
      { reviewerId: 'c', roleKey: 'r', competencyKey: 'c', band: 'mid', level: 4 },
    ];
    const gaps = peerGaps(rows);
    expect(gaps.get('a')).toEqual({ n: 1, meanAbsGap: 2 });
    expect(gaps.get('b')).toEqual({ n: 1, meanAbsGap: 1 });
  });

  it('says nothing about a competency only one person reviewed', () => {
    const gaps = peerGaps([{ reviewerId: 'a', roleKey: 'r', competencyKey: 'c', band: 'mid', level: 2 }]);
    expect(gaps.size).toBe(0);
  });

  it('does not compare across different roles or bands', () => {
    const rows: PeerLevel[] = [
      { reviewerId: 'a', roleKey: 'r1', competencyKey: 'c', band: 'mid', level: 1 },
      { reviewerId: 'b', roleKey: 'r2', competencyKey: 'c', band: 'mid', level: 5 },
    ];
    expect(peerGaps(rows).size).toBe(0);
  });
});

describe('patternAlerts', () => {
  const orgReviews = [
    ...many(40, { reviewerId: 'norm1', overridesUp: 1, overridesWithReason: 1 }),
    ...many(40, { reviewerId: 'norm2', overridesUp: 1, overridesWithReason: 1 }),
  ];

  it('a small sample never produces an alert, however extreme it looks', () => {
    const odd = many(9, { reviewerId: 'x', agreedWithAi: false, humanVerdict: 'DO_NOT_PROGRESS', overridesDown: 5 });
    const reviews = [...orgReviews, ...odd];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    expect(patternAlerts(stats, organisationBaseline(reviews, gaps))).toEqual([]);
  });

  it('a reviewer who matches the organisation raises nothing', () => {
    const reviews = [...orgReviews, ...many(20, { reviewerId: 'x', overridesUp: 1, overridesWithReason: 1 })];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    expect(patternAlerts(stats, organisationBaseline(reviews, gaps))).toEqual([]);
  });

  it('flags a reviewer who diverges from the AI far more than colleagues', () => {
    const reviews = [...orgReviews, ...many(30, { reviewerId: 'x', agreedWithAi: false, overridesUp: 1, overridesWithReason: 1 })];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    const alerts = patternAlerts(stats, organisationBaseline(reviews, gaps));
    expect(alerts.map((a) => a.kind)).toContain('divergence_from_ai');
  });

  it('flags a verdict mix far from the organisation', () => {
    const reviews = [...orgReviews, ...many(30, { reviewerId: 'x', humanVerdict: 'DO_NOT_PROGRESS', overridesUp: 1, overridesWithReason: 1 })];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    const alerts = patternAlerts(stats, organisationBaseline(reviews, gaps));
    expect(alerts.map((a) => a.kind)).toContain('verdict_mix');
  });

  it('flags verdicts recorded seconds after the assessment is opened', () => {
    const reviews = [...orgReviews, ...many(20, { reviewerId: 'x', secondsToRecord: 8, overridesUp: 1, overridesWithReason: 1 })];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    const alerts = patternAlerts(stats, organisationBaseline(reviews, gaps));
    expect(alerts.map((a) => a.kind)).toContain('time_to_record');
  });

  it('flags level changes that nearly always move downward', () => {
    const reviews = [...orgReviews, ...many(20, { reviewerId: 'x', overridesDown: 2, overridesWithReason: 2 })];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    const alerts = patternAlerts(stats, organisationBaseline(reviews, gaps));
    expect(alerts.map((a) => a.kind)).toContain('override_direction');
  });

  it('flags level changes recorded without a reason', () => {
    const reviews = [...orgReviews, ...many(20, { reviewerId: 'x', overridesUp: 2, overridesWithReason: 0 })];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    const alerts = patternAlerts(stats, organisationBaseline(reviews, gaps));
    expect(alerts.map((a) => a.kind)).toContain('evidence_cited');
  });

  it('only uses pass-rate skew when the statistics supply it', () => {
    const reviews = [...orgReviews, ...many(20, { reviewerId: 'x', overridesUp: 1, overridesWithReason: 1 })];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    const base = organisationBaseline(reviews, gaps);
    expect(patternAlerts(stats, base).map((a) => a.kind)).not.toContain('pass_rate_skew');
    const withSkew = patternAlerts(stats, base, { passRateSkew: { observed: 0.2, baseline: 0.6, n: 20 } });
    expect(withSkew.map((a) => a.kind)).toContain('pass_rate_skew');
  });

  it('does not raise pass-rate skew on a gap the sample cannot support', () => {
    const reviews = [...orgReviews, ...many(20, { reviewerId: 'x', overridesUp: 1, overridesWithReason: 1 })];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    const base = organisationBaseline(reviews, gaps);
    // 6 of 12 against a 40% baseline: a 10-point gap whose interval spans it.
    const noisy = patternAlerts(stats, base, { passRateSkew: { observed: 0.5, baseline: 0.4, n: 12 } });
    expect(noisy.map((a) => a.kind)).not.toContain('pass_rate_skew');
  });

  it('never uses accusing words, and always asks a person to look', () => {
    const reviews = [
      ...orgReviews,
      ...many(30, { reviewerId: 'x', agreedWithAi: false, humanVerdict: 'DO_NOT_PROGRESS', overridesDown: 3, overridesWithReason: 0, secondsToRecord: 4 }),
    ];
    const gaps = peerGaps([]);
    const stats = reviewerStatistics('x', reviews, gaps.get('x'), T);
    const alerts = patternAlerts(stats, organisationBaseline(reviews, gaps), { passRateSkew: { observed: 0.1, baseline: 0.7, n: 30 } });
    expect(alerts.length).toBeGreaterThan(3);
    for (const alert of alerts) {
      const lower = alert.statement.toLowerCase();
      for (const word of NEVER_SAY) expect(lower).not.toContain(word);
      expect(alert.statement.startsWith('Worth a look:')).toBe(true);
      expect(lower).toContain('not a finding');
    }
  });
});

describe('heldOutReviewers', () => {
  it('holds out a reviewer whose pattern would skew what the model learns', () => {
    expect(heldOutReviewers([{ reviewerId: 'x', kind: 'divergence_from_ai' }])).toEqual(['x']);
  });

  it('does not hold out someone merely for recording verdicts quickly', () => {
    expect(heldOutReviewers([{ reviewerId: 'x', kind: 'time_to_record' }])).toEqual([]);
  });

  it('does not hold out someone for writing less down', () => {
    expect(heldOutReviewers([{ reviewerId: 'x', kind: 'evidence_cited' }])).toEqual([]);
  });

  it('does not hold out someone on evidence that has no confidence interval', () => {
    // Distance from colleagues is a mean in levels, not a proportion: there is
    // no interval behind it, so it is worth a look and carries no consequence.
    expect(heldOutReviewers([{ reviewerId: 'x', kind: 'divergence_from_peers' }])).toEqual([]);
  });

  it('lists each reviewer once however many alerts they carry', () => {
    expect(heldOutReviewers([
      { reviewerId: 'x', kind: 'divergence_from_ai' },
      { reviewerId: 'x', kind: 'verdict_mix' },
    ])).toEqual(['x']);
  });
});
