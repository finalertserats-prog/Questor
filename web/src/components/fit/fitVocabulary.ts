/**
 * The browser's copy of how a CV-versus-role reading is worded.
 *
 * It is a copy because the browser cannot import from the server workspace.
 * `server/tests/fitVocabulary.test.ts` compares the two files as text and fails
 * if they part company, so a band added on one side without the other stops the
 * build rather than reaching a screen.
 *
 * The rule the table exists to keep: fit is a screening aid, and the decision
 * has its own vocabulary (components/assessment/verdictVocabulary.ts). Nothing
 * here may borrow a word from it.
 */

/**
 * What the engine refuses to read. Mirrored from the server rather than
 * invented here, and compared as text by server/tests/fitVocabulary.test.ts:
 * a panel that promises the engine ignores something the engine in fact reads
 * is worse than a panel that promises nothing.
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

export const FIT_BAND_MEANINGS: Readonly<Record<FitBand, string>> = {
  strong_match: 'The CV evidences most of what this role asks for, including its must-haves.',
  partial_match: 'The CV evidences some of what this role asks for and is silent or thin on the rest.',
  limited_match: 'The CV evidences little of what this role asks for.',
  not_enough_evidence: 'This CV says too little about what the role asks for to read as either a match or a mismatch.',
};

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

export const FIT_CAVEAT =
  'Fit is read from the CV alone. It is a screening aid for deciding what to ask, never a decision about the candidate — the interview decides that, from what the candidate actually says.';

export const FIT_NEVER_SHOWN_TO_CANDIDATE = 'Internal to your team. A candidate is never shown their fit score.';

/**
 * A reading measured against a scorecard nobody has approved.
 *
 * Mirrored from the server (`domain/fitVocabulary.ts`). Shown, because an
 * unchecked reading is how an unchecked scorecard gets found out; labelled,
 * because a bare number on a screen looks exactly like a checked one.
 */
export const FIT_PROVISIONAL_LABEL = 'Provisional';

export const FIT_PROVISIONAL_NOTE =
  'This reading was measured against a draft scorecard that nobody has approved yet, so it is provisional. It is not used to order, filter or compare candidates, and it will be replaced the moment the scorecard is approved.';

export const FIT_PROVISIONAL_SHORT = 'Provisional — draft scorecard, not used for ordering.';

/** What `not_enough_evidence` asks the reader to do, so the silence is not filled in as "weak". */
export const FIT_NEEDS_A_PERSON =
  'This one needs a person to look at the CV. Too little of it speaks to this role for the reading to mean anything either way — that is a fact about the document, not about the candidate.';

export function isFitBand(value: unknown): value is FitBand {
  return typeof value === 'string' && (FIT_BANDS as readonly string[]).includes(value);
}

export function isFitStrength(value: unknown): value is FitStrength {
  return typeof value === 'string' && (FIT_STRENGTHS as readonly string[]).includes(value);
}
