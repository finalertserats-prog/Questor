import { describe, it, expect } from 'vitest';
import { formatHours, groupSessionStates, niceCeiling, scaleLength } from '../src/components/dashboardModel';

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

  it('rounds up to the next 1, 2 or 5 step', () => {
    expect([3, 5, 7, 12, 51].map(niceCeiling)).toEqual([5, 5, 10, 20, 100]);
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
