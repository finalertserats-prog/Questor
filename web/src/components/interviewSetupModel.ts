/**
 * What a new AI interview needs before it can be created. Kept free of React so
 * it can be unit tested (see web/tests/interviewSetupModel.test.ts).
 */

import { hasScore } from './scoreFormat';

/** The shortest and longest interview the product will set up. */
export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 120;

export interface InterviewSetup {
  readonly durationMinutes: unknown;
  readonly personaName: string;
}

/**
 * Why this interview cannot be created, or null.
 *
 * WHY it is not left to the input's own min/max: the button was not a form
 * submit, so the browser never checked them. A 0-minute interview, a
 * 999-minute one, and one whose interviewer had no name at all all reached the
 * server — which then either refused with a raw message or, worse, accepted.
 */
export function interviewSetupProblem({ durationMinutes, personaName }: InterviewSetup): string | null {
  if (!personaName.trim()) {
    return 'Give the interviewer a name — it is what the candidate is introduced to.';
  }
  if (!hasScore(durationMinutes)) {
    return `Say how long the interview should run, between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`;
  }
  if (durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
    return `An interview runs between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`;
  }
  return null;
}

/** The nearest length inside the allowed range, for a field someone has left. */
export function clampDuration(value: unknown): number {
  if (!hasScore(value)) return MIN_DURATION_MINUTES;
  return Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, Math.round(value)));
}
