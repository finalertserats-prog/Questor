import type { EvidenceGap, TurnRecord } from '../domain/types.js';
import { type CandidateIntent, detectCandidateIntent } from './candidateIntent.js';
import { answeredTurnIds } from './conversationModel.js';

/**
 * Which of the four things happened when a competency ends an interview with
 * no evidence attached to it. See {@link EvidenceGap} for what each means and
 * why one sentence for all four was a defect.
 *
 * Called ONLY when there is no evidence, so it always has an answer — there is
 * no "no gap" value to fall through to, and a caller cannot accidentally ask
 * it to explain a competency that has evidence.
 */

/**
 * The intents that mean the candidate themselves closed the question: "I don't
 * know", "not sure", or an explicit ask to move on.
 *
 * Deliberately read from `detectCandidateIntent` rather than from a pattern of
 * our own. A second spelling of "non-answer" would drift from the first, and
 * the two would then disagree about the same turn — one of them quietly, in
 * front of a reviewer. `candidateIntent` owns that definition; this file only
 * names which of its verdicts are a decline.
 */
const DECLINING: ReadonlySet<CandidateIntent> = new Set<CandidateIntent>(['non_answer', 'skip']);

export function classifyEvidenceGap(o: {
  turns: readonly TurnRecord[];
  competencyId: string;
}): EvidenceGap {
  // Both sides of the question carry the competency: the interviewer stamps it
  // on the question turn, and the answer inherits it from the question it
  // replied to (realtime/interviewEngine recordAnswer).
  const onThisCompetency = o.turns.filter((t) => t.competencyId === o.competencyId);
  const spoken = onThisCompetency.filter((t) => t.speaker === 'candidate' && t.text.trim() !== '');

  if (spoken.length === 0) {
    return onThisCompetency.some((t) => t.speaker === 'agent') ? 'unanswered' : 'not_asked';
  }

  // The same set the evidence extractor scores from, so "they answered" here
  // and "there is something to quote" there cannot disagree.
  //
  // Reaching this line means an answer of theirs was in that set and STILL no
  // span arrived. Slot attribution files every answered turn under its own
  // question's competency with no judgement of any kind — whether the answer
  // was any good is decided later, by the grader, on a non-empty evidence
  // array and a different branch of scoreCompetency. So a missing span here is
  // never "the answer was too weak to count"; it is something on our side
  // having dropped it.
  const answered = answeredTurnIds(o.turns);
  if (spoken.some((t) => answered.has(t.id))) return 'not_extracted';

  if (spoken.some((t) => DECLINING.has(detectCandidateIntent(t.text).intent))) return 'declined';

  // They spoke, but only to pause, to ask us something, or to end the sitting.
  // That is not a refusal to answer and must not be reported as one.
  return 'unanswered';
}

/**
 * What the assessment says about it, in the words a reviewer reads.
 *
 * Each states plainly what happened, and what it does and does not mean about
 * the candidate. None of them may be written so that a skim reads as a
 * shortfall.
 */
const RATIONALE: Readonly<Record<EvidenceGap, string>> = {
  not_asked:
    'No question about this competency was put during the interview, so there is nothing here to judge. '
    + 'This is a gap in the interview, not a finding about the candidate.',
  unanswered:
    'This competency was asked about, but no answer to it was recorded before the interview moved on or ended. '
    + 'Nothing is known either way about the candidate on this — it is an open question for a later round, not a shortfall.',
  declined:
    'This competency was asked about and the candidate did not answer it: their replies were non-answers '
    + '("I don\'t know", "not sure") or a request to move on. That is what was said, not a measured level — '
    + 'it shows the question went unanswered, not that the candidate lacks the skill, and no level can be inferred from it.',
  not_extracted:
    'The candidate did answer the questions put on this competency, but our own evidence extraction attached no quote to it, '
    + 'so the grader had nothing to read. This is a failure on our side, not a finding about the candidate — the transcript needs a human read.',
};

export function evidenceGapRationale(gap: EvidenceGap): string {
  return RATIONALE[gap];
}

/** The same distinction in the reviewer's list of things still to find out. */
const OPEN_QUESTION: Readonly<Record<EvidenceGap, (name: string) => string>> = {
  not_asked: (name) => `${name} was not asked about in this interview — an open question for a later round.`,
  unanswered: (name) => `${name} was asked about but no answer was recorded — put the question again in a human round.`,
  // The guard travels with the sentence: a list of open questions is skimmed,
  // and "did not answer" on its own line reads as a shortfall without it.
  declined: (name) => `${name} was asked about and the candidate did not answer it (they said they did not know, or asked to move on) — no level can be inferred from that, so put the question again in a human round.`,
  not_extracted: (name) => `${name} was answered but no evidence could be attached to it automatically — the transcript needs a human read. This is a gap on our side.`,
};

export function evidenceGapOpenQuestion(gap: EvidenceGap, competencyName: string): string {
  return OPEN_QUESTION[gap](competencyName);
}
