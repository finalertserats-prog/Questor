import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DURATION_MINUTES, DEFAULT_TONE, MAX_DURATION_MINUTES, MIN_DURATION_MINUTES, TONE_CHOICES,
  clampDuration, coveredCompetencyNames, interviewSetupProblem,
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

/**
 * What the setup form promises the person setting the interview up. The form
 * says "the competencies on this role's approved scorecard" and then lists
 * them; if the list came from a different scorecard than the one the server
 * plans from, the form would be lying in a way nobody could see until after
 * the interview.
 *
 * Mirrors server/src/routes/interviews.ts (latest APPROVED version) and
 * server/src/domain/profileSchema.ts `isScored` (non-scoring and retired
 * competencies are never planned).
 */
describe('coveredCompetencyNames', () => {
  const comp = (name: string, over: Record<string, unknown> = {}) =>
    ({ name, classification: 'essential', ...over });
  const card = (version: number, status: string, competencies: unknown[]) =>
    ({ version, status, profile: { competencies } }) as never;

  it('lists the competencies on the approved scorecard', () => {
    expect(coveredCompetencyNames([card(1, 'approved', [comp('SQL'), comp('Stakeholder management')])]))
      .toEqual(['SQL', 'Stakeholder management']);
  });

  // The page shows the newest scorecard; the interview is planned from the
  // newest APPROVED one. A draft edited this morning is not what will be asked.
  it('ignores a newer draft in favour of the approved version the server will plan from', () => {
    expect(coveredCompetencyNames([
      card(3, 'draft', [comp('Something being considered')]),
      card(2, 'approved', [comp('SQL')]),
    ])).toEqual(['SQL']);
  });

  it('takes the highest approved version when there is more than one', () => {
    expect(coveredCompetencyNames([
      card(1, 'approved', [comp('An older idea')]),
      card(2, 'approved', [comp('SQL')]),
    ])).toEqual(['SQL']);
  });

  it('leaves out a competency that scores nothing', () => {
    expect(coveredCompetencyNames([card(1, 'approved', [comp('SQL'), comp('Notes', { classification: 'non_scoring' })])]))
      .toEqual(['SQL']);
  });

  // Retired competencies stay on the scorecard so old assessments can resolve
  // their names, but a new interview never asks about them.
  it('leaves out a retired competency', () => {
    expect(coveredCompetencyNames([card(1, 'approved', [comp('SQL'), comp('An old one', { retired: true })])]))
      .toEqual(['SQL']);
  });

  it('gives nothing when no scorecard has been approved yet', () => {
    expect(coveredCompetencyNames([card(1, 'draft', [comp('SQL')])])).toEqual([]);
  });

  it('gives nothing rather than throwing when the role has not loaded', () => {
    expect(coveredCompetencyNames([])).toEqual([]);
    expect(coveredCompetencyNames([{ version: 1, status: 'approved', profile: null } as never])).toEqual([]);
  });

  /**
   * This runs on the candidate page from whatever /roles/:id sent. A shape
   * nobody expected must cost the form its competency list, not cost the
   * recruiter the whole page — which is what a throw here would do, because
   * the render is what calls it.
   */
  it('gives nothing rather than throwing when competencies are not a list', () => {
    expect(coveredCompetencyNames([{ version: 1, status: 'approved', profile: { competencies: 'SQL' } } as never])).toEqual([]);
  });

  it('skips a competency whose name is not text', () => {
    expect(coveredCompetencyNames([card(1, 'approved', [comp('SQL'), { classification: 'essential', name: 7 }])]))
      .toEqual(['SQL']);
  });
});

/**
 * The form shows these as the defaults; the server applies them when the form
 * leaves a field out. Two copies of a default is how a form comes to promise
 * 45 minutes and get 30.
 */
describe('the defaults the form shows', () => {
  it('starts an interview at the length the server would have chosen', () => {
    expect(DEFAULT_DURATION_MINUTES).toBe(45);
  });

  it('starts on the tone the server would have chosen', () => {
    expect(DEFAULT_TONE).toBe('warm');
  });

  it('offers exactly the tones the server accepts', () => {
    expect(TONE_CHOICES.map((t) => t.value)).toEqual(['warm', 'neutral', 'formal']);
  });

  it('has the default among the tones it offers', () => {
    expect(TONE_CHOICES.some((t) => t.value === DEFAULT_TONE)).toBe(true);
  });

  /**
   * Every setting on the form claims, in one line, what it changes. A setting
   * with no explanation is the thing this screen was rebuilt to remove.
   */
  it('explains every tone it offers', () => {
    for (const tone of TONE_CHOICES) {
      expect(tone.label.length).toBeGreaterThan(0);
      expect(tone.help.length).toBeGreaterThan(10);
    }
  });

  it('never suggests a tone changes the questions or the marking', () => {
    for (const tone of TONE_CHOICES) {
      expect(tone.help).not.toMatch(/harder|easier|tough|strict|lenient|score|scoring|mark/i);
    }
  });
});
