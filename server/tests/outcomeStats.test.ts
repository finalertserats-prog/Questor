import { describe, expect, it } from 'vitest';
import {
  OUTCOME_MIN_SAMPLE,
  buildFunnel,
  countFunnel,
  cutBy,
  healthStats,
  levelDistribution,
  quantiles,
  rateOf,
  scoreDistribution,
  unblindedAgreement,
  type OutcomeRow,
  type ReviewDifferenceRow,
} from '../src/domain/outcomeStats.js';

/**
 * The arithmetic under the Reports page, against fixtures whose answers were
 * worked out by hand. Every function here is pure, so the numbers on that page
 * can be checked without a database, a tenant or a clock.
 *
 * The rule these tests exist to hold is the small-sample rule: a rate computed
 * on fewer than OUTCOME_MIN_SAMPLE observations is still computed, but is
 * marked unreadable and always carries its denominator, so nothing downstream
 * can print a percentage that nobody should read.
 */

function row(over: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    sessionId: 's1',
    roleId: 'r1',
    roleTitle: 'Backend Engineer',
    interviewerId: 'maya',
    interviewerName: 'Maya',
    experienceBand: 'established',
    regionCode: 'in',
    scorecardId: 'sc1',
    scorecardLabel: 'Backend Engineer v1',
    month: '2026-08',
    invited: true,
    started: true,
    completed: true,
    assessed: true,
    aiVerdict: 'PROCEED',
    humanReviewed: true,
    humanVerdict: 'PROCEED',
    hired: false,
    overallScore: 72,
    competencyLevels: [{ id: 'sql', name: 'SQL', level: 4 }],
    durationMinutes: 40,
    candidateTurns: 10,
    nonAnswerTurns: 1,
    evidenceCoverage: 0.8,
    rejoins: 0,
    feedbackHeld: false,
    agentTurns: 12,
    degradedTurns: 0,
    ...over,
  };
}

describe('rateOf', () => {
  it('returns null for a rate with no denominator', () => {
    expect(rateOf(0, 0).value).toBeNull();
  });

  it('reports the denominator alongside every rate', () => {
    expect(rateOf(7, 28)).toEqual({ numerator: 7, denominator: 28, value: 0.25, readable: true });
  });

  it('marks a rate below the minimum sample unreadable', () => {
    expect(rateOf(1, OUTCOME_MIN_SAMPLE - 1).readable).toBe(false);
  });

  it('marks a rate at the minimum sample readable', () => {
    expect(rateOf(1, OUTCOME_MIN_SAMPLE).readable).toBe(true);
  });

  it('still computes the value of an unreadable rate, so the export keeps the count', () => {
    expect(rateOf(1, 2).value).toBe(0.5);
  });

  it('rounds to four decimal places', () => {
    expect(rateOf(1, 3).value).toBe(0.3333);
  });

  it('treats an empty denominator as unreadable rather than as zero per cent', () => {
    expect(rateOf(0, 0).readable).toBe(false);
  });
});

describe('buildFunnel', () => {
  const counts = {
    invited: 100, started: 80, completed: 60, assessed: 55, humanReviewed: 40,
    proceed: 16, consider: 14, doNotProgress: 10, hired: 8,
  } as const;

  it('reads every step against the step it came from', () => {
    const steps = buildFunnel(counts);
    const started = steps.find((s) => s.key === 'started');
    expect(started?.basis).toBe('invited');
    expect(started?.ofBasis?.value).toBe(0.8);
  });

  it('reads the three verdicts against the reviews they came from, not against each other', () => {
    const steps = buildFunnel(counts);
    for (const key of ['proceed', 'consider', 'doNotProgress'] as const) {
      expect(steps.find((s) => s.key === key)?.basis).toBe('humanReviewed');
    }
    expect(steps.find((s) => s.key === 'consider')?.ofBasis?.value).toBe(0.35);
  });

  it('names the verdicts in the one vocabulary', () => {
    const labels = buildFunnel(counts).map((s) => s.label);
    expect(labels).toContain('Proceed');
    expect(labels).toContain('Consider');
    expect(labels).toContain('Do not progress');
    expect(labels).not.toContain('APPROVED');
  });

  it('gives the first step no basis rate', () => {
    expect(buildFunnel(counts)[0]).toMatchObject({ key: 'invited', basis: null, ofBasis: null });
  });

  it('also reads every step against the whole intake', () => {
    expect(buildFunnel(counts).find((s) => s.key === 'hired')?.ofInvited?.value).toBe(0.08);
  });

  it('reads hiring against the people a reviewer said to proceed with', () => {
    expect(buildFunnel(counts).find((s) => s.key === 'hired')?.basis).toBe('proceed');
  });

  it('marks every rate unreadable when the whole funnel is a handful of people', () => {
    const tiny = buildFunnel({ invited: 4, started: 3, completed: 2, assessed: 2, humanReviewed: 1, proceed: 1, consider: 0, doNotProgress: 0, hired: 1 });
    expect(tiny.filter((s) => s.ofBasis?.readable === true)).toEqual([]);
  });

  it('survives an empty period without dividing by zero', () => {
    const empty = buildFunnel({ invited: 0, started: 0, completed: 0, assessed: 0, humanReviewed: 0, proceed: 0, consider: 0, doNotProgress: 0, hired: 0 });
    expect(empty.every((s) => s.count === 0)).toBe(true);
    expect(empty.find((s) => s.key === 'started')?.ofBasis?.value).toBeNull();
  });
});

describe('countFunnel', () => {
  it('counts each stage from the rows that reached it', () => {
    const rows = [
      row({ sessionId: 'a' }),
      row({ sessionId: 'b', completed: false, assessed: false, aiVerdict: null, humanReviewed: false, humanVerdict: null }),
      row({ sessionId: 'c', humanVerdict: 'DO_NOT_PROGRESS' }),
      row({ sessionId: 'd', hired: true }),
    ];
    expect(countFunnel(rows)).toEqual({
      invited: 4, started: 4, completed: 3, assessed: 3, humanReviewed: 3,
      proceed: 2, consider: 0, doNotProgress: 1, hired: 1,
    });
  });

  it('counts an interview nobody was invited to out of the intake', () => {
    expect(countFunnel([row({ invited: false })]).invited).toBe(0);
  });
});

describe('quantiles', () => {
  it('has nothing to report about an empty sample', () => {
    expect(quantiles([])).toMatchObject({ n: 0, median: null, q1: null, q3: null, readable: false });
  });

  it('takes the midpoint of an even sample', () => {
    expect(quantiles([1, 2, 3, 4]).median).toBe(2.5);
  });

  it('takes the middle value of an odd sample', () => {
    expect(quantiles([5, 1, 3]).median).toBe(3);
  });

  it('interpolates the quartiles of a known sample', () => {
    // R-7 on 1..9: h = (9-1)*0.25 = 2 -> x[2] = 3; h = 6 -> x[6] = 7.
    expect(quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9])).toMatchObject({ q1: 3, q3: 7 });
  });

  it('reports the range it was computed over', () => {
    expect(quantiles([4, 9, 2])).toMatchObject({ min: 2, max: 9 });
  });

  it('marks a small sample unreadable', () => {
    expect(quantiles([1, 2, 3]).readable).toBe(false);
  });

  it('marks a sample at the threshold readable', () => {
    expect(quantiles(Array.from({ length: OUTCOME_MIN_SAMPLE }, (_, i) => i)).readable).toBe(true);
  });
});

describe('levelDistribution', () => {
  it('shows every level on the scale, including the ones nobody scored', () => {
    const dist = levelDistribution([2, 2, 4], [1, 2, 3, 4, 5]);
    expect(dist.counts).toEqual([
      { level: 1, count: 0 }, { level: 2, count: 2 }, { level: 3, count: 0 },
      { level: 4, count: 1 }, { level: 5, count: 0 },
    ]);
  });

  it('reports the median of the levels, not their mean', () => {
    expect(levelDistribution([1, 1, 5], [1, 2, 3, 4, 5]).median).toBe(1);
  });

  it('leaves out a value that is not on the scale rather than inventing a level for it', () => {
    expect(levelDistribution([2, 99], [1, 2, 3]).n).toBe(1);
  });

  it('reports an empty distribution as empty, not as all-zero-scored', () => {
    expect(levelDistribution([], [1, 2, 3])).toMatchObject({ n: 0, median: null, readable: false });
  });
});

describe('scoreDistribution', () => {
  it('buckets scores by ten and keeps the bucket bounds', () => {
    const dist = scoreDistribution([0, 9, 10, 72, 100], 10);
    expect(dist.buckets[0]).toEqual({ from: 0, to: 10, count: 2 });
    expect(dist.buckets.at(-1)).toEqual({ from: 90, to: 100, count: 1 });
  });

  it('puts a perfect score in the last bucket rather than past the end', () => {
    expect(scoreDistribution([100], 10).buckets.reduce((n, b) => n + b.count, 0)).toBe(1);
  });

  it('reports the quartiles of the scores themselves, not of the buckets', () => {
    expect(scoreDistribution([10, 20, 30, 40, 50], 10).median).toBe(30);
  });

  it('has no buckets and no median for an empty sample', () => {
    expect(scoreDistribution([], 10)).toMatchObject({ n: 0, median: null, readable: false });
  });
});

describe('cutBy', () => {
  const rows: OutcomeRow[] = [
    ...Array.from({ length: 21 }, (_, i) => row({ sessionId: `m${i}`, interviewerId: 'maya', interviewerName: 'Maya', humanVerdict: i < 7 ? 'PROCEED' : 'DO_NOT_PROGRESS', overallScore: 50 + i })),
    ...Array.from({ length: 3 }, (_, i) => row({ sessionId: `t${i}`, interviewerId: 'theo', interviewerName: 'Theo', humanVerdict: 'PROCEED', overallScore: 90 })),
  ];

  it('carries the sample size of every cut', () => {
    const groups = cutBy(rows, 'interviewer');
    expect(groups.map((g) => [g.key, g.n])).toEqual([['maya', 21], ['theo', 3]]);
  });

  it('reads a large cut', () => {
    const maya = cutBy(rows, 'interviewer').find((g) => g.key === 'maya');
    expect(maya?.humanVerdicts.PROCEED).toEqual({ numerator: 7, denominator: 21, value: 0.3333, readable: true });
  });

  it('refuses to let a three-interview cut be read as a rate', () => {
    const theo = cutBy(rows, 'interviewer').find((g) => g.key === 'theo');
    expect(theo?.humanVerdicts.PROCEED).toMatchObject({ numerator: 3, denominator: 3, readable: false });
  });

  it('orders cuts by sample size, largest first', () => {
    expect(cutBy(rows, 'interviewer').map((g) => g.key)).toEqual(['maya', 'theo']);
  });

  it('gathers rows with no value for the dimension under one named group', () => {
    const groups = cutBy([row({ experienceBand: '' })], 'experienceBand');
    expect(groups[0]).toMatchObject({ key: '', label: 'Not recorded', n: 1 });
  });

  it('cuts by month', () => {
    const groups = cutBy([row({ month: '2026-07' }), row({ sessionId: 's2', month: '2026-08' })], 'month');
    expect(groups.map((g) => g.key).sort()).toEqual(['2026-07', '2026-08']);
  });

  it('orders a monthly cut by month rather than by size, so a trend reads left to right', () => {
    const rowsByMonth = [
      row({ sessionId: 'a', month: '2026-09' }),
      row({ sessionId: 'b', month: '2026-07' }), row({ sessionId: 'c', month: '2026-07' }),
      row({ sessionId: 'd', month: '2026-08' }),
    ];
    expect(cutBy(rowsByMonth, 'month').map((g) => g.key)).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('reports the score spread of a cut', () => {
    const theo = cutBy(rows, 'interviewer').find((g) => g.key === 'theo');
    expect(theo?.score).toMatchObject({ n: 3, median: 90, readable: false });
  });

  it('has nothing to say about an empty period', () => {
    expect(cutBy([], 'interviewer')).toEqual([]);
  });
});

describe('healthStats', () => {
  it('reports the non-answer rate over candidate turns, with its denominator', () => {
    const rows = [row({ candidateTurns: 10, nonAnswerTurns: 2 }), row({ sessionId: 's2', candidateTurns: 30, nonAnswerTurns: 2 })];
    expect(healthStats(rows).nonAnswer).toEqual({ numerator: 4, denominator: 40, value: 0.1, readable: true });
  });

  it('reports the degraded-turn rate over agent turns', () => {
    const rows = [row({ agentTurns: 25, degradedTurns: 5 })];
    expect(healthStats(rows).degradedTurns).toMatchObject({ numerator: 5, denominator: 25, value: 0.2 });
  });

  it('counts a held feedback email against the interviews in the period', () => {
    const rows = [row({ feedbackHeld: true }), row({ sessionId: 's2' })];
    expect(healthStats(rows).heldFeedback).toMatchObject({ numerator: 1, denominator: 2, readable: false });
  });

  it('counts rejoined interviews, not rejoin events, against the interviews', () => {
    const rows = [row({ rejoins: 3 }), row({ sessionId: 's2', rejoins: 0 })];
    expect(healthStats(rows).rejoined).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it('averages evidence coverage only over the interviews that were assessed', () => {
    const rows = [row({ evidenceCoverage: 0.8 }), row({ sessionId: 's2', assessed: false, evidenceCoverage: null })];
    expect(healthStats(rows).evidenceCoverage).toMatchObject({ n: 1, mean: 0.8, readable: false });
  });

  it('reports duration from the interviews that have one', () => {
    const rows = [row({ durationMinutes: 30 }), row({ sessionId: 's2', durationMinutes: null })];
    expect(healthStats(rows).duration).toMatchObject({ n: 1, median: 30 });
  });

  it('says nothing rather than zero for an empty period', () => {
    expect(healthStats([])).toMatchObject({ n: 0, nonAnswer: { value: null }, evidenceCoverage: { mean: null } });
  });
});

describe('unblindedAgreement', () => {
  function diff(over: Partial<ReviewDifferenceRow> = {}): ReviewDifferenceRow {
    return {
      aiRecommendation: 'PROCEED', humanDisposition: 'PROCEED', agreed: true,
      competencies: [{ competencyId: 'sql', competencyName: 'SQL', aiLevel: 3, humanLevel: 3, changed: false }],
      ...over,
    };
  }

  it('counts agreement with its denominator', () => {
    const rows = [diff(), diff(), diff({ humanDisposition: 'CONSIDER', agreed: false })];
    expect(unblindedAgreement(rows).agreed).toMatchObject({ numerator: 2, denominator: 3, readable: false });
  });

  it('shows where the two parted company, by what the AI had said', () => {
    const rows = [
      diff({ aiRecommendation: 'PROCEED', humanDisposition: 'DO_NOT_PROGRESS', agreed: false }),
      diff({ aiRecommendation: 'PROCEED' }),
    ];
    const proceed = unblindedAgreement(rows).byAiRecommendation.find((r) => r.recommendation === 'PROCEED');
    expect(proceed?.humanCounts).toEqual({ PROCEED: 1, CONSIDER: 0, DO_NOT_PROGRESS: 1 });
  });

  it('counts which way the competency levels moved', () => {
    const rows = [
      diff({ competencies: [{ competencyId: 'a', competencyName: 'A', aiLevel: 4, humanLevel: 2, changed: true }] }),
      diff({ competencies: [{ competencyId: 'b', competencyName: 'B', aiLevel: 1, humanLevel: 3, changed: true }] }),
      diff(),
    ];
    expect(unblindedAgreement(rows).competencyChanges).toMatchObject({ aiHigher: 1, humanHigher: 1, changed: { numerator: 2, denominator: 3 } });
  });

  it('ignores a difference row whose verdicts are not in the vocabulary', () => {
    expect(unblindedAgreement([diff({ humanDisposition: 'APPROVED' })]).n).toBe(0);
  });

  it('has nothing to report when nobody has reviewed anything', () => {
    expect(unblindedAgreement([])).toMatchObject({ n: 0, agreed: { value: null, readable: false } });
  });
});
