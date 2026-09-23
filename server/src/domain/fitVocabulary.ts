/**
 * How a CV-versus-role reading is allowed to be worded.
 *
 * Fit is a SCREENING AID. The interview decides, and the decision has one
 * vocabulary already (domain/verdict.ts: Proceed / Consider / Do not progress).
 * So nothing here may borrow a word from it: a reader who sees "Consider" on a
 * resume panel will believe a decision has been made about a person no one has
 * spoken to yet. Every band below is a statement about EVIDENCE — what the CV
 * does and does not show — and never about what to do with the candidate.
 *
 * `server/tests/fitVocabulary.test.ts` holds both halves of that rule: the
 * browser's copy of this table must match, and no label may contain a verdict.
 */

/**
 * Characteristics that may never influence a score, and the things that stand
 * in for them. Name, photograph, date of birth, graduation year and country of
 * education are here not because they are secret but because each one predicts
 * a protected characteristic well enough to launder it into a number.
 *
 * Published with the panel rather than described by it: a screen that recites
 * this list from its own hardcoded copy can drift from what the engine actually
 * refuses to read, and then the promise on the screen is no longer true.
 */
export const EXCLUDED_SIGNALS: readonly string[] = [
  'name', 'photograph', 'age', 'date of birth', 'gender', 'marital status', 'caste',
  'religion', 'nationality', 'ethnicity', 'health or disability', 'home address',
  'contact details', 'graduation year', 'institution or country of education',
  'employment gaps', 'school prestige', 'writing polish and CV length',
];

export const FIT_BANDS = ['strong_match', 'partial_match', 'limited_match', 'not_enough_evidence'] as const;
export type FitBand = (typeof FIT_BANDS)[number];

export const FIT_BAND_LABELS: Readonly<Record<FitBand, string>> = {
  strong_match: 'Strong evidence of fit',
  partial_match: 'Partial evidence of fit',
  limited_match: 'Limited evidence of fit',
  not_enough_evidence: 'Not enough on the CV to say',
};

/** What each band means, in one sentence, said to HR. */
export const FIT_BAND_MEANINGS: Readonly<Record<FitBand, string>> = {
  strong_match: 'The CV evidences most of what this role asks for, including its must-haves.',
  partial_match: 'The CV evidences some of what this role asks for and is silent or thin on the rest.',
  limited_match: 'The CV evidences little of what this role asks for.',
  not_enough_evidence: 'This CV says too little about what the role asks for to read as either a match or a mismatch.',
};

/** How a band is drawn: a rule and a word, never a fill. */
export const FIT_BAND_TONE: Readonly<Record<FitBand, 'pass' | 'hold' | 'stop' | 'neutral'>> = {
  strong_match: 'pass',
  partial_match: 'hold',
  limited_match: 'stop',
  not_enough_evidence: 'neutral',
};

export const FIT_STRENGTHS = ['evidenced', 'partial', 'not_evidenced'] as const;
export type FitStrength = (typeof FIT_STRENGTHS)[number];

export const FIT_STRENGTH_LABELS: Readonly<Record<FitStrength, string>> = {
  evidenced: 'Evidenced',
  partial: 'Thinly evidenced',
  not_evidenced: 'Not evidenced',
};

/**
 * The sentence that has to sit next to every fit number, everywhere it is
 * shown. It is one string in one place because it was three copies in three
 * files, and copies drift.
 */
export const FIT_CAVEAT =
  'Fit is read from the CV alone. It is a screening aid for deciding what to ask, never a decision about the candidate — the interview decides that, from what the candidate actually says.';

/** Said on every surface where a candidate could conceivably see it. */
export const FIT_NEVER_SHOWN_TO_CANDIDATE = 'Internal to your team. A candidate is never shown their fit score.';

/**
 * A competency whose score is carried at neutral because the CV neither
 * evidences it nor contradicts it. Not zero: a CV that does not mention
 * stakeholder management is not a CV that proves someone cannot do it.
 */
export const UNEVIDENCED_NEUTRAL_SCORE = 40;

/**
 * The most a well-presented CV may gain over a plainly-written one that says
 * the same things.
 *
 * This is a structural bound, not a hope. Every component of a fit score reads
 * FACTS — a competency evidenced or not, a technology dated or not, a figure
 * stated or not — except one, which measures how much of the role's own
 * vocabulary the CV happens to echo. That one is wording-sensitive by nature,
 * so it is given exactly this many points of weight and no more. The motto is
 * evidence, not polish, and a motto that is not enforced somewhere in the code
 * is decoration.
 */
export const PRESENTATION_MAX_POINTS = 4;

export function fitBandOf(overall: number, coverage: number, mustHaveGaps: number): FitBand {
  if (coverage < 0.35) return 'not_enough_evidence';
  if (mustHaveGaps > 0) return overall >= 55 ? 'partial_match' : 'limited_match';
  if (overall >= 75 && coverage >= 0.6) return 'strong_match';
  if (overall >= 55) return 'partial_match';
  return 'limited_match';
}
