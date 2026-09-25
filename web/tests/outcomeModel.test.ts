import { describe, expect, it } from 'vitest';
import {
  CUT_MEASURES,
  PERIOD_PRESETS,
  cutBars,
  funnelBars,
  levelColumns,
  measureRate,
  monthLabel,
  percent,
  periodRange,
  readRate,
  scoreColumns,
  spreadSentence,
  type CutGroup,
  type FunnelStep,
  type Rate,
} from '../src/components/reports/outcomeModel';

/**
 * What the Reports page is allowed to say about a number.
 *
 * The rule these tests hold: a percentage never appears on its own. It arrives
 * with the count it was computed from, and below the minimum sample it arrives
 * with a sentence saying it must not be read.
 */

const MIN = 20;

function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    value: denominator ? Math.round((numerator / denominator) * 10000) / 10000 : null,
    readable: denominator >= MIN,
  };
}

describe('percent', () => {
  it('reads a proportion as a whole percentage', () => {
    expect(percent(0.3333)).toBe('33%');
  });

  it('says nothing rather than zero when there was nothing to measure', () => {
    expect(percent(null)).toBe('—');
  });

  it('keeps one decimal place for a rate below one per cent, so it is not rounded to nothing', () => {
    expect(percent(0.004)).toBe('0.4%');
  });
});

describe('readRate', () => {
  it('always gives the counts beside the percentage', () => {
    expect(readRate(rate(7, 28), MIN)).toMatchObject({ percent: '25%', counts: '7 of 28', readable: true, note: '' });
  });

  it('says a small sample must not be read, and names the threshold', () => {
    const read = readRate(rate(1, 3), MIN);
    expect(read.readable).toBe(false);
    expect(read.note).toContain('20');
  });

  it('still shows the counts of a sample too small to read', () => {
    expect(readRate(rate(1, 3), MIN).counts).toBe('1 of 3');
  });

  it('distinguishes nothing measured from zero per cent', () => {
    expect(readRate(rate(0, 0), MIN)).toMatchObject({ percent: '—', counts: 'nothing measured' });
  });

  it('has something to say about a missing rate', () => {
    expect(readRate(null, MIN)).toMatchObject({ percent: '—', readable: false });
  });
});

describe('funnelBars', () => {
  const funnel: FunnelStep[] = [
    { key: 'invited', label: 'Invited', count: 100, basis: null, ofBasis: null, ofInvited: null },
    { key: 'started', label: 'Started', count: 80, basis: 'invited', ofBasis: rate(80, 100), ofInvited: rate(80, 100) },
    { key: 'completed', label: 'Completed', count: 60, basis: 'started', ofBasis: rate(60, 80), ofInvited: rate(60, 100) },
  ];

  it('draws the first step full, because it is the whole intake', () => {
    expect(funnelBars(funnel, MIN)[0]).toMatchObject({ key: 'invited', value: 1, counts: '100' });
  });

  it('draws each later step at its share of everyone invited, so the bars nest', () => {
    expect(funnelBars(funnel, MIN)[2]).toMatchObject({ key: 'completed', value: 0.6 });
  });

  it('labels a step with the step it came from', () => {
    expect(funnelBars(funnel, MIN)[1].counts).toBe('80 of 100 invited');
  });

  it('marks a step whose sample is too small to read', () => {
    const tiny: FunnelStep[] = [
      { key: 'invited', label: 'Invited', count: 3, basis: null, ofBasis: null, ofInvited: null },
      { key: 'started', label: 'Started', count: 2, basis: 'invited', ofBasis: rate(2, 3), ofInvited: rate(2, 3) },
    ];
    expect(funnelBars(tiny, MIN)[1].readable).toBe(false);
  });

  it('has no bars for an empty funnel', () => {
    expect(funnelBars([], MIN)).toEqual([]);
  });
});

describe('cut measures', () => {
  const group: CutGroup = {
    key: 'maya', label: 'Maya', n: 24,
    started: rate(24, 24), completed: rate(20, 24), assessed: rate(20, 24), humanReviewed: rate(18, 24),
    aiVerdicts: { PROCEED: rate(10, 20), CONSIDER: rate(6, 20), DO_NOT_PROGRESS: rate(4, 20) },
    humanVerdicts: { PROCEED: rate(9, 18), CONSIDER: rate(5, 18), DO_NOT_PROGRESS: rate(4, 18) },
    hired: rate(3, 24),
    score: { n: 20, median: 70, q1: 60, q3: 80, min: 40, max: 95, readable: true },
    readable: true,
  };

  it('offers a measure for each thing a cut can differ on', () => {
    expect(CUT_MEASURES.map((m) => m.key)).toEqual(['completed', 'humanReviewed', 'proceed', 'doNotProgress', 'hired']);
  });

  it('reads a verdict measure against the reviews, not against the interviews', () => {
    expect(measureRate(group, 'proceed')).toMatchObject({ numerator: 9, denominator: 18 });
  });

  it('reads completion against the interviews', () => {
    expect(measureRate(group, 'completed')).toMatchObject({ numerator: 20, denominator: 24 });
  });

  it('puts the sample size in every bar label', () => {
    expect(cutBars([group], 'proceed', MIN)[0].counts).toBe('9 of 18');
  });

  it('marks a group below the threshold unreadable however big the rate looks', () => {
    const small: CutGroup = { ...group, key: 'theo', label: 'Theo', n: 3, humanVerdicts: { ...group.humanVerdicts, PROCEED: rate(3, 3) } };
    expect(cutBars([small], 'proceed', MIN)[0]).toMatchObject({ readable: false, percent: '100%', counts: '3 of 3' });
  });

  it('has nothing to draw for a dimension with no groups', () => {
    expect(cutBars([], 'proceed', MIN)).toEqual([]);
  });
});

describe('distribution columns', () => {
  it('turns score buckets into labelled columns', () => {
    expect(scoreColumns([{ from: 0, to: 10, count: 2 }, { from: 90, to: 100, count: 1 }])).toEqual([
      { key: '0-10', label: '0–10', count: 2 },
      { key: '90-100', label: '90–100', count: 1 },
    ]);
  });

  it('turns competency levels into labelled columns, keeping the empty ones', () => {
    expect(levelColumns([{ level: 0, count: 0 }, { level: 1, count: 3 }])).toEqual([
      { key: '0', label: 'Level 0', count: 0 },
      { key: '1', label: 'Level 1', count: 3 },
    ]);
  });
});

describe('spreadSentence', () => {
  it('states the median, the quartiles and the sample', () => {
    expect(spreadSentence({ n: 40, median: 70, q1: 60, q3: 80, min: 20, max: 99, readable: true }, ''))
      .toBe('Median 70, middle half 60 to 80, over 40 interviews.');
  });

  it('warns when the spread was computed on too few interviews', () => {
    expect(spreadSentence({ n: 3, median: 70, q1: 60, q3: 80, min: 60, max: 80, readable: false }, ''))
      .toContain('too few');
  });

  it('carries the unit when there is one', () => {
    expect(spreadSentence({ n: 40, median: 32, q1: 25, q3: 40, min: 5, max: 60, readable: true }, ' min'))
      .toContain('Median 32 min');
  });

  it('says nothing was measured rather than reporting a zero median', () => {
    expect(spreadSentence({ n: 0, median: null, q1: null, q3: null, min: null, max: null, readable: false }, ''))
      .toBe('Nothing measured in this period.');
  });
});

describe('monthLabel', () => {
  it('reads a stored month as a month', () => {
    expect(monthLabel('2026-09')).toBe('Sep 2026');
  });

  it('hands back anything it does not recognise unchanged, rather than guessing', () => {
    expect(monthLabel('maya')).toBe('maya');
  });
});

describe('period presets', () => {
  it('offers the periods a hiring team actually reviews', () => {
    expect(PERIOD_PRESETS.map((p) => p.key)).toEqual(['90d', '180d', '365d', 'all']);
  });

  it('computes a range ending now', () => {
    const now = new Date('2026-09-23T00:00:00.000Z');
    expect(periodRange('90d', now)?.from.toISOString()).toBe('2026-06-25T00:00:00.000Z');
  });

  it('asks the server for everything when the period is "all"', () => {
    expect(periodRange('all', new Date())).toBeNull();
  });
});
