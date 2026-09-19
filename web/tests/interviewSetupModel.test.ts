import { describe, it, expect } from 'vitest';
import {
  MAX_DURATION_MINUTES, MIN_DURATION_MINUTES, clampDuration, interviewSetupProblem,
} from '../src/components/interviewSetupModel';

const setup = (over: Partial<{ durationMinutes: unknown; interviewer: string }> = {}) =>
  ({ durationMinutes: 45, interviewer: 'random', ...over });

describe('interviewSetupProblem', () => {
  it('allows a sensible interview', () => {
    expect(interviewSetupProblem(setup())).toBe(null);
  });

  it('allows the shortest and longest interviews offered', () => {
    expect([
      interviewSetupProblem(setup({ durationMinutes: MIN_DURATION_MINUTES })),
      interviewSetupProblem(setup({ durationMinutes: MAX_DURATION_MINUTES })),
    ]).toEqual([null, null]);
  });

  // The defect: the button was not a form submit, so the input's own min and
  // max were never checked and a zero-minute interview was POSTed.
  it('refuses an interview with no time in it', () => {
    expect(interviewSetupProblem(setup({ durationMinutes: 0 }))).toContain('between');
  });

  it('refuses an interview longer than anyone will sit through', () => {
    expect(interviewSetupProblem(setup({ durationMinutes: 999 }))).toContain('between');
  });

  it('refuses a cleared duration field rather than reading it as zero', () => {
    expect(interviewSetupProblem(setup({ durationMinutes: Number.NaN }))).toContain('how long');
  });

  it('allows a named interviewer as well as Random', () => {
    expect(interviewSetupProblem(setup({ interviewer: 'maya' }))).toBe(null);
  });

  it('refuses a setup with no interviewer chosen, since that is who the candidate meets', () => {
    expect(interviewSetupProblem(setup({ interviewer: '   ' }))).toContain('interviewer');
  });

  it('reports the missing interviewer first, since it is the one a person can see is wrong', () => {
    expect(interviewSetupProblem(setup({ interviewer: '', durationMinutes: 0 }))).toContain('interviewer');
  });
});

describe('clampDuration', () => {
  it('leaves a length inside the range alone', () => {
    expect(clampDuration(45)).toBe(45);
  });

  it('pulls a too-short interview up to the minimum', () => {
    expect(clampDuration(2)).toBe(MIN_DURATION_MINUTES);
  });

  it('pulls a too-long one down to the maximum', () => {
    expect(clampDuration(999)).toBe(MAX_DURATION_MINUTES);
  });

  it('treats a cleared field as the shortest interview rather than none', () => {
    expect(clampDuration(Number.NaN)).toBe(MIN_DURATION_MINUTES);
  });

  it('rounds a fractional length', () => {
    expect(clampDuration(45.6)).toBe(46);
  });
});
