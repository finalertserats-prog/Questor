import { describe, it, expect } from 'vitest';
import { barRadius, chartTone, countAxis, formatHours, groupSessionStates, niceCeiling, scaleLength, statesInGroup, trimSparseWeeks, truncationNote, TRUNCATION_NOTE } from '../src/components/dashboardModel';

describe('truncationNote', () => {
  it('says the charts were drawn from a capped set when the server capped one', () => {
    expect(truncationNote(true)).toBe(TRUNCATION_NOTE);
  });

  it('names the cap, so the reader knows what is missing', () => {
    expect(TRUNCATION_NOTE).toContain('20,000');
  });

  it('says nothing when the series covers everything', () => {
    expect(truncationNote(false)).toBe(null);
  });

  // An older server does not send the flag at all; absent is not truncated.
  it('says nothing when the flag is missing', () => {
    expect(truncationNote(undefined)).toBe(null);
  });

  it('says nothing for a value that is not the flag', () => {
    expect([truncationNote('true'), truncationNote(1), truncationNote(null)]).toEqual([null, null, null]);
  });
});

describe('groupSessionStates', () => {
  it('folds raw session states into the groups an HR reader thinks in', () => {
    const groups = groupSessionStates({ INVITED: 2, PROVISIONED: 1, ASSESSING: 1, REVIEW_READY: 3, HUMAN_REVIEWED: 1, CLOSED: 2, NO_SHOW: 1 });
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ['scheduled', 3], ['live', 1], ['review', 3], ['reviewed', 3], ['stopped', 1],
    ]);
  });

  it('keeps every group present at zero when there is no data', () => {
    expect(groupSessionStates({}).every((g) => g.count === 0)).toBe(true);
  });

  it('adds an Other group only for states it does not recognise', () => {
    const groups = groupSessionStates({ SOMETHING_NEW: 2 });
    expect(groups.at(-1)).toEqual({ key: 'other', label: 'Other', count: 2 });
  });
});

describe('niceCeiling', () => {
  it('returns 1 for an empty series so the chart never divides by zero', () => {
    expect(niceCeiling(0)).toBe(1);
  });

  it('rounds up to the next nice step', () => {
    expect([3, 5, 7, 12, 51].map(niceCeiling)).toEqual([3, 5, 8, 15, 60]);
  });

  it('does not strand a series under an axis it can never reach', () => {
    // The dashboard's own case: 30 interviews drawn against an axis of 50 left
    // the tallest bar at three fifths of the plot and the rest empty.
    expect(niceCeiling(30)).toBe(30);
  });
});

describe('scaleLength', () => {
  it('scales a value proportionally into the available length', () => {
    expect(scaleLength(5, 10, 120)).toBe(60);
  });

  it('never exceeds the available length', () => {
    expect(scaleLength(50, 10, 120)).toBe(120);
  });

  it('draws nothing for a zero or negative value', () => {
    expect([scaleLength(0, 10, 120), scaleLength(-3, 10, 120)]).toEqual([0, 0]);
  });
});

describe('countAxis', () => {
  const counts = Array.from({ length: 1000 }, (_, i) => i + 1);

  it('labels a count axis in whole numbers', () => {
    // The dashboard's own case: five interviews drawn against 0, 1.3, 2.5, 3.8, 5.
    expect(countAxis(5).ticks).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('never produces a fractional tick for any count up to a thousand', () => {
    expect(counts.filter((n) => !countAxis(n).ticks.every(Number.isInteger))).toEqual([]);
  });

  it('always reaches the largest value', () => {
    expect(counts.filter((n) => countAxis(n).max < n)).toEqual([]);
  });

  it('keeps the axis to a handful of steps', () => {
    expect(counts.filter((n) => countAxis(n).ticks.length > 7)).toEqual([]);
  });

  it('ends the axis on its last tick', () => {
    const axis = countAxis(51);
    expect(axis.ticks.at(-1)).toBe(axis.max);
  });

  it('steps by a round integer for larger counts', () => {
    expect(countAxis(51).ticks).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it('does not strand a series under an axis it can never reach', () => {
    expect(countAxis(30).max).toBe(30);
  });

  it('draws a 0 to 1 axis for an empty series so the chart never divides by zero', () => {
    expect(countAxis(0)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe('chartTone', () => {
  it('gives every group the state grouping can produce a fill', () => {
    const keys = groupSessionStates({ SOMETHING_NEW: 1 }).map((g) => g.key);
    expect(keys.filter((k) => chartTone(k) === 'tone-muted')).toEqual(['other']);
  });

  it('marks awaiting-review with the one warm emphasis tone', () => {
    expect(chartTone('review')).toBe('tone-spark');
  });

  it('falls back to a muted fill rather than no fill for an unknown group', () => {
    expect(chartTone('a-group-nobody-styled')).toBe('tone-muted');
  });
});

describe('barRadius', () => {
  it('uses the full design radius on a bar that can carry it', () => {
    expect(barRadius(40, 60)).toBe(5);
  });

  it('clamps to half the height so a short bar is not rounded away', () => {
    expect(barRadius(40, 6)).toBe(3);
  });

  it('clamps to half the width so a thin bar keeps its shape', () => {
    expect(barRadius(4, 60)).toBe(2);
  });

  it('draws no corner on a bar with no length, so zero paints nothing', () => {
    expect(barRadius(0, 16)).toBe(0);
  });

  it('draws no corner on a bar with no height either', () => {
    expect(barRadius(16, 0)).toBe(0);
  });
});

describe('formatHours', () => {
  it('shows a dash when there is no data', () => {
    expect(formatHours(null)).toBe('—');
  });

  it('shows under an hour as <1h', () => {
    expect(formatHours(0.4)).toBe('<1h');
  });

  it('shows whole hours below two days', () => {
    expect(formatHours(15.4)).toBe('15h');
  });

  it('shows days with one decimal from two days up', () => {
    expect(formatHours(60)).toBe('2.5d');
  });
});

describe('trimSparseWeeks', () => {
  const w = (weekStart: string, created: number, completed = 0) => ({ weekStart, created, completed });

  it('drops the empty weeks on either side of the activity', () => {
    const series = [w('2026-06-01', 0), w('2026-06-08', 4), w('2026-06-15', 2), w('2026-06-22', 0)];
    expect(trimSparseWeeks(series).map((d) => d.weekStart)).toEqual(['2026-06-08', '2026-06-15']);
  });

  it('keeps quiet weeks that sit between two active ones, because a gap is the point', () => {
    const series = [w('2026-06-01', 3), w('2026-06-08', 0), w('2026-06-15', 5)];
    expect(trimSparseWeeks(series)).toHaveLength(3);
  });

  it('returns the whole series when nothing happened, so the chart still has an axis', () => {
    const series = [w('2026-06-01', 0), w('2026-06-08', 0)];
    expect(trimSparseWeeks(series)).toEqual(series);
  });

  it('counts a week active when only completions land in it', () => {
    const series = [w('2026-06-01', 0, 0), w('2026-06-08', 0, 2)];
    expect(trimSparseWeeks(series).map((d) => d.weekStart)).toEqual(['2026-06-08']);
  });
});

describe('statesInGroup', () => {
  it('names the states behind the stopped group, so a filter cannot drift from the chart', () => {
    expect(statesInGroup('stopped')).toContain('CANDIDATE_WITHDREW');
  });

  it('returns nothing for a group that does not exist', () => {
    expect(statesInGroup('not-a-group')).toEqual([]);
  });
});
