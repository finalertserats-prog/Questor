/**
 * What a new AI interview needs before it can be created. Kept free of React so
 * it can be unit tested (see web/tests/interviewSetupModel.test.ts).
 */

import { hasScore } from './scoreFormat';

/** The shortest and longest interview the product will set up. */
export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 120;
/** What Set up interview starts from, and what inviting a bulk import uses for everyone. */
export const DEFAULT_DURATION_MINUTES = 45;
export const INTERVIEW_MODULES: readonly string[] = ['warmup', 'technical', 'behavioral', 'wrapup'];

export interface InterviewSetup {
  readonly durationMinutes: unknown;
  /** 'random' or an interviewer id. */
  readonly interviewer: string;
}

/**
 * Why this interview cannot be created, or null.
 *
 * WHY it is not left to the input's own min/max: the button was not a form
 * submit, so the browser never checked them. A 0-minute interview, a
 * 999-minute one, and one with no interviewer at all all reached the server —
 * which then either refused with a raw message or, worse, accepted.
 */
export function interviewSetupProblem({ durationMinutes, interviewer }: InterviewSetup): string | null {
  if (!interviewer.trim()) {
    return 'Choose an AI interviewer, or Random — it is who the candidate is introduced to.';
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
