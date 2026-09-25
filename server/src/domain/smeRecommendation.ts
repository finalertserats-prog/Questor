/**
 * What a subject-matter expert may say about a candidate.
 *
 * Two words, and deliberately not the three in domain/verdict.ts.
 *
 * The verdict vocabulary exists because one judgement was being recorded in two
 * languages; this is the opposite case. An SME's recommendation and a
 * reviewer's verdict are two different acts that happen to sound alike: the
 * verdict is decided upon — `decisionOfVerdict` turns PROCEED into APPROVED and
 * services/pipelineAutonomy.ts moves the candidate — and the recommendation is
 * read by a person who then decides for themselves. Sharing the type would put
 * an SME's opinion one careless `decisionOfVerdict(...)` away from moving
 * somebody between stages, and nothing in the compiler would object. Different
 * words, different type, and the mistake stops being expressible.
 *
 * Lower case, matching the contract (docs/credentials-contract.md §2) and
 * unlike the upper-case verdicts, so the two are not confused on sight either.
 */

export const SME_RECOMMENDATIONS = ['proceed', 'do_not_proceed'] as const;

export type SmeRecommendation = (typeof SME_RECOMMENDATIONS)[number];

export const SME_RECOMMENDATION_LABELS: Readonly<Record<SmeRecommendation, string>> = {
  proceed: 'Proceed',
  do_not_proceed: 'Do not proceed',
};

export function isSmeRecommendation(value: unknown): value is SmeRecommendation {
  return typeof value === 'string' && (SME_RECOMMENDATIONS as readonly string[]).includes(value);
}

/** The recommendation in the words HR reads it in; the stored value when it is from a future version. */
export function smeRecommendationLabel(value: string): string {
  return isSmeRecommendation(value) ? SME_RECOMMENDATION_LABELS[value] : value;
}

/**
 * The shortest true sentence about what a recommendation does, shown wherever
 * one is displayed.
 *
 * Stated rather than implied: an HR user looking at a page that says "Proceed"
 * in the same typeface the verdict uses will reasonably assume the system has
 * acted on it, and the one thing that must not be assumed here is that anybody
 * has moved.
 */
export const SME_ADVISORY_NOTE = 'A recommendation. It moves nobody on its own — the decision stays with the hiring team.';

/** The longest a recommendation may be argued for. Long enough for reasoning, short enough to read. */
export const SME_FEEDBACK_MAX = 5000;

/**
 * Whether written reasoning is enough to be worth recording.
 *
 * A recommendation with no argument behind it is the thing calibration cannot
 * use: the whole point of asking an expert is learning where they and the
 * machine read a candidate differently, and "Proceed" alone says only the what.
 */
export const SME_FEEDBACK_MIN = 20;
