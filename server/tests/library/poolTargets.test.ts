import { describe, expect, it } from 'vitest';
import { BASE_DEPTH_IN_USE, BASE_DEPTH_LONG_TAIL, depthTarget, expectedInterviewsInWindow, formMixSatisfied, formMixTarget, poolHealth } from '../../src/library/poolTargets.js';

/** The pool-depth formula and the form-mix rule from the plan, as pure arithmetic. */

describe('depthTarget', () => {
  it('gives 54 for 43 expected interviews, as the plan works it', () => {
    expect(depthTarget({ expectedInterviewsInWindow: 43, inUse: true })).toBe(54);
  });

  it('never drops below base depth 12 for a role in use', () => {
    expect(depthTarget({ expectedInterviewsInWindow: 2, inUse: true })).toBe(BASE_DEPTH_IN_USE);
  });

  it('uses base depth 6 for the long tail', () => {
    expect(depthTarget({ expectedInterviewsInWindow: 0, inUse: false })).toBe(BASE_DEPTH_LONG_TAIL);
  });

  it('multiplies by ladders per interview when given', () => {
    expect(depthTarget({ expectedInterviewsInWindow: 20, inUse: true, laddersPerInterview: 2 })).toBe(50);
  });
});

describe('expectedInterviewsInWindow', () => {
  it('scales the last 60 days to the no-repeat window', () => {
    expect(expectedInterviewsInWindow({ interviewsLast60Days: 86, windowDays: 30 })).toBe(43);
  });

  it('falls back to the family average when the role has no history', () => {
    expect(expectedInterviewsInWindow({ interviewsLast60Days: 0, windowDays: 30, familyAverageLast60Days: 12 })).toBe(6);
  });
});

describe('formMixTarget', () => {
  it('spreads the depth over at least three forms', () => {
    expect(Object.keys(formMixTarget(12)).length).toBeGreaterThanOrEqual(3);
  });

  it('caps every form at half the depth', () => {
    expect(Math.max(...Object.values(formMixTarget(6)))).toBeLessThanOrEqual(3);
  });

  it('sums to the depth', () => {
    expect(Object.values(formMixTarget(14)).reduce((a, b) => a + b, 0)).toBe(14);
  });
});

describe('formMixSatisfied', () => {
  it('accepts three forms none over half', () => {
    expect(formMixSatisfied({ star: 4, opinion: 4, tradeoff: 4 }).ok).toBe(true);
  });

  it('refuses a form over half the pool', () => {
    expect(formMixSatisfied({ star: 7, opinion: 3, tradeoff: 2 }).problems).toContain('star over 50%');
  });

  it('refuses fewer than three forms', () => {
    expect(formMixSatisfied({ star: 3, opinion: 3 }).problems).toContain('fewer than three forms');
  });
});

describe('poolHealth', () => {
  it('is empty with no live entries', () => {
    expect(poolHealth({ live: 0, target: 12 })).toBe('empty');
  });

  it('is thin below target', () => {
    expect(poolHealth({ live: 5, target: 12 })).toBe('thin');
  });

  it('is ready at target', () => {
    expect(poolHealth({ live: 12, target: 12 })).toBe('ready');
  });
});
