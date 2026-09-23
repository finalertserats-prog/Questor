import { describe, it, expect } from 'vitest';
import {
  CLOSE_OUT_STATES, firstUnreviewed, humanReviewRefusal, outcomeNeedsHumanReview, reviewRequirementFor,
  type ConductedInterview,
} from '../src/domain/humanReviewRule.js';
import { EXCEPTION_STATES, SESSION_STATES } from '../src/domain/stateMachine.js';

/**
 * The rule behind the sentence on the candidate's consent screen: "A person on
 * the hiring team reviews the interview."
 *
 * What is tested here is which interviews the promise covers, because that is
 * where a rule like this goes wrong. Too narrow and the promise is decorative;
 * too broad and a candidate who withdrew is stuck in a pipeline nobody can
 * close, which is a worse failure than the one it set out to fix.
 */

const INTERVIEW: ConductedInterview = {
  sessionId: 'session-1',
  state: 'REVIEW_READY',
  humanReviewRequired: true,
  assessmentId: 'assessment-1',
  retaken: false,
  reviewed: false,
};

const one = (over: Partial<ConductedInterview> = {}): ConductedInterview => ({ ...INTERVIEW, ...over });

describe('when the promise applies', () => {
  it('requires a review of an assessed AI interview whose consent recorded it', () => {
    expect(reviewRequirementFor(one())).toMatchObject({ required: true, satisfied: false, assessmentId: 'assessment-1' });
  });

  it('is satisfied once a completed review claims the assessment', () => {
    expect(reviewRequirementFor(one({ reviewed: true }))).toMatchObject({ required: true, satisfied: true });
  });

  it('names the session as well as the assessment, so the refusal can point at the interview', () => {
    expect(reviewRequirementFor(one())).toMatchObject({ sessionId: 'session-1' });
  });
});

describe('when it does not', () => {
  // The whole point of the flag: an interview consented before this rule
  // existed made no such promise, and inventing one retroactively would
  // refuse to close out candidates nobody ever owed a review.
  it('treats a consent record with no flag as not required', () => {
    expect(reviewRequirementFor(one({ humanReviewRequired: undefined }))).toEqual({ required: false, because: 'not_recorded' });
  });

  it('honours an interview created with human review turned off', () => {
    expect(reviewRequirementFor(one({ humanReviewRequired: false }))).toEqual({ required: false, because: 'turned_off' });
  });

  it('requires nothing of an interview that produced no assessment', () => {
    expect(reviewRequirementFor(one({ assessmentId: null }))).toEqual({ required: false, because: 'no_assessment' });
  });

  it('requires nothing of the attempt a retake replaced', () => {
    expect(reviewRequirementFor(one({ retaken: true }))).toEqual({ required: false, because: 'retaken' });
  });

  it.each(CLOSE_OUT_STATES)('lets a person close out an interview in %s', (state) => {
    expect(reviewRequirementFor(one({ state }))).toEqual({ required: false, because: 'closed_out' });
  });

  // The exemption list is written out rather than imported, so the rule does
  // not drag the state machine (and Express, through it) into the domain. This
  // is what keeps the copy honest: every state an interview can END in without
  // having happened is a state a person must be able to close out from, so a
  // new exception state added upstream and not added here fails right here
  // rather than silently stranding candidates.
  it('exempts exactly the states an interview can fail into', () => {
    expect([...CLOSE_OUT_STATES].sort()).toEqual([...EXCEPTION_STATES].sort());
  });

  // The mirror of the above: a state the interview passes THROUGH on its way to
  // being reviewable must never become an exemption.
  it('exempts none of the states a real interview passes through', () => {
    const exempt = SESSION_STATES.filter((state) => CLOSE_OUT_STATES.includes(state));
    expect(exempt).toEqual([]);
  });

  // Ordering matters for the record, not just the answer: a candidate who
  // withdrew should be exempt for having withdrawn, not for the incidental
  // reason that their abandoned interview was never scored.
  it('exempts a withdrawn candidate for withdrawing, even when an assessment exists', () => {
    expect(reviewRequirementFor(one({ state: 'CANDIDATE_WITHDREW' }))).toEqual({ required: false, because: 'closed_out' });
  });
});

describe('across a candidate history', () => {
  it('finds nothing to answer for a candidate with no AI interview at all', () => {
    expect(firstUnreviewed([])).toBeNull();
  });

  it('reports the first interview that still owes a review', () => {
    const missing = firstUnreviewed([one({ reviewed: true }), one({ sessionId: 'session-2', assessmentId: 'assessment-2' })]);
    expect(missing).toMatchObject({ assessmentId: 'assessment-2' });
  });

  // A second interview that has not been assessed yet must not excuse the
  // first one nobody read — otherwise scheduling a retake is the way round.
  it('does not let a later unassessed interview excuse an earlier unreviewed one', () => {
    const missing = firstUnreviewed([one(), one({ sessionId: 'session-2', assessmentId: null })]);
    expect(missing).toMatchObject({ assessmentId: 'assessment-1' });
  });

  it('is satisfied when every covered interview has been reviewed', () => {
    expect(firstUnreviewed([one({ reviewed: true }), one({ sessionId: 'session-2', humanReviewRequired: undefined })])).toBeNull();
  });
});

describe('which outcomes the promise gates', () => {
  it('gates an approval', () => {
    expect(outcomeNeedsHumanReview('APPROVED')).toBe(true);
  });

  it('gates a rejection', () => {
    expect(outcomeNeedsHumanReview('REJECTED')).toBe(true);
  });

  // A withdrawal is the candidate leaving, not a judgement about them.
  // Requiring a review first would keep someone in a pipeline they asked out of.
  it('does not gate a withdrawal', () => {
    expect(outcomeNeedsHumanReview('WITHDRAWN')).toBe(false);
  });
});

describe('the refusal', () => {
  it('says what was promised and links to the review that is missing', () => {
    const missing = firstUnreviewed([one()]);
    const text = humanReviewRefusal(missing!);
    expect(text).toContain('a person on the hiring team would review their interview');
    expect(text).toContain('/assessments/assessment-1');
  });
});
