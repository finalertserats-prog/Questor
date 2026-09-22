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

/**
 * What the form starts on, and what the server would apply for a field the
 * form left out (server/src/routes/interviews.ts `createSchema`). The form
 * shows these as the defaults, so they have to be the same number.
 */
export const DEFAULT_DURATION_MINUTES = 45;
export const DEFAULT_TONE = 'warm';

export type InterviewTone = 'warm' | 'neutral' | 'formal';

/**
 * The tones, each with the one line the form shows under it.
 *
 * The help text is held here rather than in the JSX so the rule below it can
 * be a test: a tone changes how the interviewer speaks and nothing else. It
 * does not change which questions are asked, how hard they are, or how the
 * answers are marked — and copy that hints otherwise would have HR choosing
 * "Formal" to interview someone more harshly.
 */
export const TONE_CHOICES: ReadonlyArray<{
  readonly value: InterviewTone;
  readonly label: string;
  readonly help: string;
}> = [
  { value: 'warm', label: 'Warm', help: 'friendly and encouraging, with a little small talk.' },
  { value: 'neutral', label: 'Neutral', help: 'plain and even, straight from one question to the next.' },
  { value: 'formal', label: 'Formal', help: 'businesslike and reserved, closer to a panel interview.' },
];

/** A competency as the role endpoint sends it. */
export interface SetupCompetency {
  readonly name: string;
  readonly classification?: string;
  readonly retired?: boolean;
}

/** A scorecard version as the role endpoint sends it. */
export interface SetupScorecard {
  readonly version: number;
  readonly status: string;
  readonly profile: { readonly competencies?: readonly SetupCompetency[] } | null;
}

/** Competencies with this classification score nothing, so nothing asks about them. */
const NON_SCORING = 'non_scoring';

/**
 * What this interview will actually ask about, in the role's own order.
 *
 * Taken from the latest APPROVED scorecard, not the latest one — that is the
 * version POST /interviews plans from, and a draft somebody is midway through
 * editing is not what the candidate will be asked. Non-scoring and retired
 * competencies are dropped, matching `isScored` on the server: they stay on
 * the scorecard so old assessments can still resolve their names, but no new
 * plan includes them.
 *
 * `'approved'` is compared exactly, because that is the literal the server
 * both stores and queries with (prisma/schema.prisma: `draft | approved`).
 * Matching it loosely would accept a status the server would not.
 *
 * Every shape is checked rather than trusted. This is called during render,
 * from whatever /roles/:id sent, so a response nobody anticipated has to cost
 * the form its list of competencies — not cost the recruiter the page.
 */
export function coveredCompetencyNames(scorecards: readonly SetupScorecard[]): readonly string[] {
  // `filter` already returns a new array, so the `sort` never reorders the
  // caller's list — the page's own copy of the role response.
  const approved = scorecards
    .filter((card) => card?.status === 'approved')
    .sort((a, b) => b.version - a.version)[0];
  const competencies = approved?.profile?.competencies;
  if (!Array.isArray(competencies)) return [];
  return competencies
    .filter((c) => c && c.classification !== NON_SCORING && c.retired !== true)
    .map((c) => (typeof c.name === 'string' ? c.name.trim() : ''))
    .filter((name) => name.length > 0);
}

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
