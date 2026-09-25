import type { DecisionOutcome } from './pipelineAutonomy.js';
import type { PipelineStage } from './pipelineStages.js';

/**
 * The promise on the candidate's consent screen — "A person on the hiring team
 * reviews the interview" — expressed as a rule.
 *
 * Until now that sentence was true only by convention. `humanReviewRequired`
 * was written into the consent record when the interview was created and never
 * read again, so a pipeline decision could be recorded on a candidate whose AI
 * interview nobody had opened. This module decides, for one AI interview,
 * whether the promise applies to it and whether it has been kept; the database
 * work is in services/humanReviewGate.ts and the pure arithmetic is here so it
 * can be tested without a session, an assessment or a reviewer.
 *
 * Two things this rule deliberately does NOT do:
 *
 *  - It does not block ordinary pipeline work. A candidate with no AI
 *    interview, or with one that produced nothing to read, is not covered: the
 *    promise was never made to them, and a rule that stopped their pipeline
 *    would be a bug wearing a compliance badge.
 *  - It does not apply retroactively. An interview consented before this rule
 *    existed has no `humanReviewRequired` recorded at all, and a missing flag
 *    means NOT required. We will not invent a promise nobody made and then
 *    refuse to close the candidate out because of it.
 */

/**
 * Session states in which a person must still be able to close the candidate
 * out without a review.
 *
 * Each of these is an interview that did not happen, or did not finish. There
 * is no conversation for anybody to read, so requiring a review of one would
 * strand the candidate in the pipeline forever — the opposite of the care the
 * promise is about. This list is explicit rather than implied by "there is no
 * assessment": an assessment can exist for an interrupted interview, and a
 * candidate who withdrew must be closeable even if it does.
 */
export const CLOSE_OUT_STATES: readonly string[] = [
  'NO_SHOW',
  'CANDIDATE_WITHDREW',
  'TECHNICAL_FAILURE',
  'POLICY_STOP',
  'MANUAL_HANDOFF',
  'CANCELLED',
  'INCOMPLETE',
  'RESCHEDULE_REQUIRED',
];

/** One AI interview, as much of it as the rule needs to see. */
export interface ConductedInterview {
  readonly sessionId: string;
  readonly state: string;
  /**
   * What the consent record says. `undefined` means the consent record has no
   * such key — an interview consented before the flag was enforced.
   */
  readonly humanReviewRequired: boolean | undefined;
  /** The assessment a reviewer would open, or null when the interview produced none. */
  readonly assessmentId: string | null;
  /** True when a later attempt replaced this one (InterviewSession.retakeOfSessionId). */
  readonly retaken: boolean;
  /** True when an active, completed, unsuperseded review exists for `assessmentId`. */
  readonly reviewed: boolean;
}

export type NotRequiredBecause =
  /** The consent record predates the rule: no flag, no promise, no block. */
  | 'not_recorded'
  /** The interview was created with human review explicitly turned off. */
  | 'turned_off'
  /** Nothing was produced for anyone to review. */
  | 'no_assessment'
  /** The interview did not happen or did not finish; a person closes it out. */
  | 'closed_out'
  /** A retake replaced this attempt; the retake is the one that must be read. */
  | 'retaken';

export type ReviewRequirement =
  | { readonly required: false; readonly because: NotRequiredBecause }
  | { readonly required: true; readonly satisfied: true; readonly sessionId: string; readonly assessmentId: string }
  | { readonly required: true; readonly satisfied: false; readonly sessionId: string; readonly assessmentId: string };

/**
 * Whether the promise applies to this interview, and whether it has been kept.
 *
 * Order matters. The cheapest and least arguable exemptions come first so that
 * a candidate who withdrew is exempt for THAT reason in the record, rather than
 * for the incidental reason that their abandoned interview produced no
 * assessment.
 */
export function reviewRequirementFor(interview: ConductedInterview): ReviewRequirement {
  if (interview.humanReviewRequired === undefined) return { required: false, because: 'not_recorded' };
  if (!interview.humanReviewRequired) return { required: false, because: 'turned_off' };
  if (CLOSE_OUT_STATES.includes(interview.state)) return { required: false, because: 'closed_out' };
  if (interview.retaken) return { required: false, because: 'retaken' };
  if (!interview.assessmentId) return { required: false, because: 'no_assessment' };
  const where = { sessionId: interview.sessionId, assessmentId: interview.assessmentId };
  return interview.reviewed ? { required: true, satisfied: true, ...where } : { required: true, satisfied: false, ...where };
}

export type UnreviewedInterview = Extract<ReviewRequirement, { satisfied: false }>;

/**
 * The first interview in this candidate's history that still owes a review, or
 * null when the promise is kept (or was never made). Every AI interview for the
 * role is considered, not just the latest: a second interview that has not been
 * assessed yet must not excuse the first one nobody read.
 *
 * "First" is the caller's order, not a sort done here — this function has no
 * timestamps to sort by. services/humanReviewGate.ts reads them oldest first
 * (createdAt, then id), which is what makes the refusal point the reviewer at
 * the earliest interview still owed rather than an arbitrary one.
 */
export function firstUnreviewed(interviews: readonly ConductedInterview[]): UnreviewedInterview | null {
  for (const interview of interviews) {
    const requirement = reviewRequirementFor(interview);
    if (requirement.required && !requirement.satisfied) return requirement;
  }
  return null;
}

/**
 * Which outcomes the promise gates.
 *
 * Approving and rejecting are judgements ABOUT the interview, and recording one
 * without reading it is precisely what the candidate was promised would not
 * happen. A withdrawal is not a judgement: the candidate has left, or the
 * requisition has, and making somebody read an interview before they can honour
 * that would keep a person in a pipeline they asked to leave. So withdrawal is
 * always allowed — explicitly, and recorded as the exemption it is.
 */
export function outcomeNeedsHumanReview(outcome: DecisionOutcome): boolean {
  return outcome !== 'WITHDRAWN';
}

/**
 * Which stage moves the promise gates.
 *
 * Not every move is a judgement about the interview. Moving a candidate TO the
 * round the AI conducts says nothing about how it went — it has not happened
 * yet, and in the ordinary order of things it has not even been booked. Moving
 * them OUT of it does: it is the act that says the round went well enough to go
 * on, and it is the act that strikes the credential for it
 * (domain/candidateAwards.ts, awardsForPromotion). Everything past that round
 * is the same, which is why the last stage's own button checks too.
 *
 * So the gate sits on leaving the AI round or anything after it. A plan with no
 * AI-conducted stage has no interview to promise a reading of, and gates
 * nothing.
 *
 * This exists because `POST /pipelines/:id/advance` had no check at all, and
 * the "Needs you" queue then made that endpoint the ordinary way a candidate is
 * promoted. A recruiter holds `interview:create` and deliberately holds neither
 * `assessment:review` nor the right to decide or finalise — and one press of
 * Move to Gold was striking a Silver credential, in their name, on an interview
 * nobody had opened.
 */
export function moveNeedsHumanReview(stages: readonly PipelineStage[], fromStageKey: string): boolean {
  const aiRound = stages.findIndex((stage) => stage.kind === 'ai_interview');
  if (aiRound < 0) return false;
  const leaving = stages.findIndex((stage) => stage.key === fromStageKey);
  return leaving >= 0 && leaving >= aiRound;
}

/**
 * What the reviewer is told when the decision is refused. Names the missing
 * thing and where to do it, because "403" sends people to ask an administrator
 * for a permission that would not have helped.
 */
export function humanReviewRefusal(missing: UnreviewedInterview): string {
  return 'This candidate was told a person on the hiring team would review their interview, and no one has. '
    + `Open the assessment and record a review first: /assessments/${missing.assessmentId}`;
}

/** The error code the web client keys on, so the page can offer the review link. */
export const HUMAN_REVIEW_REQUIRED = 'human_review_required';
