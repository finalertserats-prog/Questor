import type { DecisionOutcome } from './pipelineAutonomy.js';

/**
 * The one vocabulary for the judgement on a candidate.
 *
 * The same judgement used to be recorded twice, in two languages. A reviewer
 * chose PROCEED on the assessment; the pipeline stored APPROVED; and the
 * candidate's page then said "Approved at Silver" about a decision the
 * reviewer had made in different words. Two vocabularies for one act is two
 * things to keep in step, and they did not stay in step.
 *
 * So: there is ONE set of words — Proceed, Consider, Do not progress — and it
 * is what the UI says, what a review stores, and what every sentence about a
 * pipeline decision reads back as.
 *
 * Storage keeps both enums on purpose. `CandidatePipeline.decision` holds
 * APPROVED / REJECTED / WITHDRAWN on rows that were decided months ago;
 * rewriting them would be rewriting the record of what people did. The enums
 * are therefore a storage detail, mapped here and nowhere else, and this file
 * is the only place the two are allowed to meet.
 */

export const VERDICTS = ['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS'] as const;

export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  PROCEED: 'Proceed',
  CONSIDER: 'Consider',
  DO_NOT_PROGRESS: 'Do not progress',
};

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

export function verdictLabel(verdict: Verdict): string {
  return VERDICT_LABELS[verdict];
}

/**
 * A withdrawal is not a verdict. Nobody judged the candidate: they left. It
 * can only be recorded on the pipeline itself, which is why it has a label
 * here but no verdict to map to.
 */
export const WITHDRAWN_LABEL = 'Candidate withdrew';

/**
 * Verdict → the decision the pipeline stores. CONSIDER decides nothing: it is
 * a person saying "not yet", and the pipeline waits for them.
 */
const DECISION_OF_VERDICT: Readonly<Record<Verdict, DecisionOutcome | ''>> = {
  PROCEED: 'APPROVED',
  CONSIDER: '',
  DO_NOT_PROGRESS: 'REJECTED',
};

export function decisionOfVerdict(verdict: Verdict): DecisionOutcome | null {
  return DECISION_OF_VERDICT[verdict] || null;
}

/** The stored decision read back in the one vocabulary; null for a withdrawal. */
export function verdictOfDecision(decision: DecisionOutcome): Verdict | null {
  const found = VERDICTS.find((verdict) => DECISION_OF_VERDICT[verdict] === decision);
  return found ?? null;
}

/** Any stored decision, said in the one vocabulary. */
export function outcomeLabel(decision: DecisionOutcome): string {
  const verdict = verdictOfDecision(decision);
  return verdict ? VERDICT_LABELS[verdict] : WITHDRAWN_LABEL;
}
