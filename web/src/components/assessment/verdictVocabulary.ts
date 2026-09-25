import type { IconName } from '../Icon';

/**
 * The one vocabulary for the judgement on a candidate — the browser's copy of
 * server/src/domain/verdict.ts.
 *
 * The same judgement used to be said two ways: the assessment page offered
 * "Proceed / Consider / Do not progress" and the candidate's page then
 * reported "Approved at Silver". One act, two languages, and nothing keeping
 * them in step. There is now one set of words, and the stored pipeline enum
 * (APPROVED / REJECTED / WITHDRAWN) is a storage detail that never reaches a
 * sentence a person reads.
 *
 * It is a copy because the browser cannot import from the server workspace. A
 * copy that drifts is exactly how the two vocabularies grew, so
 * server/tests/verdictVocabulary.test.ts compares the two tables as text and
 * fails if they part company.
 */

export const VERDICTS = ['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS'] as const;

export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  PROCEED: 'Proceed',
  CONSIDER: 'Consider',
  DO_NOT_PROGRESS: 'Do not progress',
};

/** The stored pipeline decision each verdict amounts to; Consider decides nothing. */
const DECISION_OF_VERDICT: Readonly<Record<Verdict, string>> = {
  PROCEED: 'APPROVED',
  CONSIDER: '',
  DO_NOT_PROGRESS: 'REJECTED',
};

/** A withdrawal is not a verdict: nobody judged the candidate, they left. */
export const WITHDRAWN_LABEL = 'Candidate withdrew';

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

export function verdictLabel(verdict: Verdict): string {
  return VERDICT_LABELS[verdict];
}

/** Any stored pipeline decision, said in the one vocabulary. */
export function outcomeLabel(decision: string): string {
  const found = VERDICTS.find((verdict) => DECISION_OF_VERDICT[verdict] === decision);
  return found ? VERDICT_LABELS[found] : WITHDRAWN_LABEL;
}

/**
 * How each verdict is marked on screen. A rule and an icon, never a fill: the
 * colour is the last thing that carries the meaning, not the first.
 */
export interface VerdictMark {
  readonly tone: 'pass' | 'hold' | 'stop';
  readonly icon: IconName;
}

const MARKS: Readonly<Record<Verdict, VerdictMark>> = {
  PROCEED: { tone: 'pass', icon: 'check-circle' },
  CONSIDER: { tone: 'hold', icon: 'question' },
  DO_NOT_PROGRESS: { tone: 'stop', icon: 'x-circle' },
};

export function verdictMark(verdict: Verdict): VerdictMark {
  return MARKS[verdict];
}
