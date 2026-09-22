import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REVIEW_WINDOW_HOURS, MAX_SEND_ATTEMPTS, afterFailedAttempt, autoCandidateFeedbackEnabled,
  blindReviewRequired, feedbackDueAt, feedbackSignOff, feedbackEligibility, manualSendAllowed,
  retryDelayMs, reviewWindowHours, type EligibilityInput,
} from '../src/services/autoFeedbackModel.js';

/**
 * The wait before feedback goes out. The owner's rule: a completed human
 * review sends it at once, and if nobody reviews it within the window it goes
 * on its own — 12 hours by default, so the hiring team has a working day's
 * grace without the candidate being left waiting.
 */
describe('the review window', () => {
  it('waits twelve hours by default', () => {
    expect(DEFAULT_REVIEW_WINDOW_HOURS).toBe(12);
  });

  it('uses the deployment default when the organisation has not chosen', () => {
    expect(reviewWindowHours({}, 12)).toBe(12);
  });

  it("uses the organisation's own window when it has", () => {
    expect(reviewWindowHours({ feedbackReviewWindowHours: 4 }, 12)).toBe(4);
  });

  it('allows no wait at all', () => {
    expect(reviewWindowHours({ feedbackReviewWindowHours: 0 }, 12)).toBe(0);
  });

  it('ignores a value that is not a sensible number of hours', () => {
    expect([reviewWindowHours({ feedbackReviewWindowHours: -3 }, 12), reviewWindowHours({ feedbackReviewWindowHours: '8' }, 12)])
      .toEqual([12, 12]);
  });

  it('counts the window from the moment the assessment was stored', () => {
    expect(feedbackDueAt(new Date('2026-09-20T08:00:00.000Z'), 12)).toEqual(new Date('2026-09-20T20:00:00.000Z'));
  });
});

describe('who the letter is signed by', () => {
  it('is Questor unless the organisation says otherwise', () => {
    expect(feedbackSignOff({})).toBe('questor');
  });

  it('is the organisation when they have asked to sign it', () => {
    expect(feedbackSignOff({ feedbackSignedByCompany: true })).toBe('company');
  });

  it('treats a malformed value as the default', () => {
    expect(feedbackSignOff({ feedbackSignedByCompany: 'yes' })).toBe('questor');
  });
});

describe('tenant policy defaults', () => {
  it('sends feedback automatically when the policy says nothing', () => {
    expect(autoCandidateFeedbackEnabled({})).toBe(true);
  });

  it('stops sending automatically only on an explicit false', () => {
    expect(autoCandidateFeedbackEnabled({ autoCandidateFeedback: false })).toBe(false);
  });

  it('treats a malformed value as the default rather than as off', () => {
    expect(autoCandidateFeedbackEnabled({ autoCandidateFeedback: 'no' })).toBe(true);
  });

  it('does not require a blind review when the policy says nothing', () => {
    expect(blindReviewRequired({})).toBe(false);
  });

  it('requires a blind review only on an explicit true', () => {
    expect(blindReviewRequired({ requireBlindReview: true })).toBe(true);
  });

  it('does not read a truthy string as requiring a blind review', () => {
    expect(blindReviewRequired({ requireBlindReview: 'yes' })).toBe(false);
  });
});

const COMPLETED: EligibilityInput = {
  state: 'REVIEW_READY', completedAt: new Date('2026-09-19T10:00:00Z'), partial: false,
  candidateEmail: 'priya@example.com', optInChoice: null, hasAssessment: true,
};

describe('which interviews get feedback', () => {
  it('sends for a completed interview with an assessment', () => {
    expect(feedbackEligibility(COMPLETED)).toEqual({ eligible: true });
  });

  it.each(['HUMAN_REVIEWED', 'CLOSED'])('still sends once the interview has moved on to %s', (state) => {
    expect(feedbackEligibility({ ...COMPLETED, state })).toEqual({ eligible: true });
  });

  const SKIPS: ReadonlyArray<readonly [string, Partial<EligibilityInput>, string]> = [
    ['a withdrawn interview', { state: 'CANDIDATE_WITHDREW' }, 'WITHDRAWN'],
    ['an incomplete interview', { state: 'INCOMPLETE', completedAt: null }, 'NOT_COMPLETED'],
    ['a technical failure', { state: 'TECHNICAL_FAILURE' }, 'NOT_COMPLETED'],
    ['a policy stop', { state: 'POLICY_STOP' }, 'NOT_COMPLETED'],
    ['a manual handoff', { state: 'MANUAL_HANDOFF' }, 'NOT_COMPLETED'],
    ['a cancelled interview', { state: 'CANCELLED' }, 'NOT_COMPLETED'],
    ['an interview still running', { state: 'ASSESSING', completedAt: null }, 'NOT_COMPLETED'],
    ['a closed interview that never completed', { state: 'CLOSED', completedAt: null }, 'NOT_COMPLETED'],
    ['a partial interview a reviewer chose to score', { partial: true }, 'PARTIAL_INTERVIEW'],
    ['a candidate with no email', { candidateEmail: '  ' }, 'NO_EMAIL'],
    ['a candidate who said no to feedback', { optInChoice: 'NO' }, 'DECLINED'],
    ['an interview with no assessment', { hasAssessment: false }, 'NO_ASSESSMENT'],
  ];

  it.each(SKIPS)('skips %s', (_label, change, reason) => {
    expect(feedbackEligibility({ ...COMPLETED, ...change })).toEqual({ eligible: false, reason });
  });

  it('sends to a candidate who said yes', () => {
    expect(feedbackEligibility({ ...COMPLETED, optInChoice: 'YES' })).toEqual({ eligible: true });
  });
});

describe('retries', () => {
  it('waits longer after each failure', () => {
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
  });

  it('never waits more than an hour', () => {
    expect(retryDelayMs(20)).toBeLessThanOrEqual(60 * 60_000);
  });

  it('queues another attempt after an early failure', () => {
    const now = new Date('2026-09-19T10:00:00Z');
    expect(afterFailedAttempt(1, now)).toEqual({ status: 'QUEUED', nextAttemptAt: new Date(now.getTime() + retryDelayMs(1)) });
  });

  it('gives up after the last attempt', () => {
    expect(afterFailedAttempt(MAX_SEND_ATTEMPTS, new Date())).toEqual({ status: 'FAILED', nextAttemptAt: null });
  });
});

describe('when "Send feedback now" is offered', () => {
  it('is offered when nothing has been sent', () => {
    expect(manualSendAllowed(null)).toEqual({ allowed: true });
  });

  it.each(['FAILED', 'DRAFT', 'HELD'])('is offered for a %s email', (status) => {
    expect(manualSendAllowed({ status, skipReason: '' })).toEqual({ allowed: true });
  });

  it.each(['POLICY_OFF', 'NO_EMAIL', 'DEMO_RECIPIENT', 'NO_ASSESSMENT'])('is offered after a skip for %s', (skipReason) => {
    expect(manualSendAllowed({ status: 'SKIPPED', skipReason })).toEqual({ allowed: true });
  });

  it.each(['SENT', 'SENDING'])('is not offered once the email is %s', (status) => {
    expect(manualSendAllowed({ status, skipReason: '' }).allowed).toBe(false);
  });

  // A queued letter is usually one waiting out the review window, and sending
  // it by hand then is the whole point of the button.
  it('is offered while the letter is still waiting for the review window', () => {
    const waiting = { status: 'QUEUED', skipReason: '', nextAttemptAt: new Date('2026-09-20T20:00:00.000Z') };
    expect(manualSendAllowed(waiting, { now: new Date('2026-09-20T09:00:00.000Z') })).toEqual({ allowed: true });
  });

  it('is not offered once that letter is due and on its way', () => {
    const due = { status: 'QUEUED', skipReason: '', nextAttemptAt: new Date('2026-09-20T09:00:00.000Z') };
    expect(manualSendAllowed(due, { now: new Date('2026-09-20T20:00:00.000Z') }).allowed).toBe(false);
  });

  it('is not offered for a queued letter with no due time at all', () => {
    expect(manualSendAllowed({ status: 'QUEUED', skipReason: '', nextAttemptAt: null }).allowed).toBe(false);
  });

  // A send whose claim was taken while it was in flight: the email may well
  // have reached the candidate, so sending again risks a duplicate.
  it('is not offered for a send we could not confirm', () => {
    expect(manualSendAllowed({ status: 'SENT_UNVERIFIED', skipReason: '' }).allowed).toBe(false);
  });

  it('says the unconfirmed send may already have reached the candidate', () => {
    const verdict = manualSendAllowed({ status: 'SENT_UNVERIFIED', skipReason: '' });
    expect(verdict.allowed === false && verdict.reason).toMatch(/may already have reached the candidate/i);
  });

  it('asks for that risk to be accepted rather than hiding the button', () => {
    const verdict = manualSendAllowed({ status: 'SENT_UNVERIFIED', skipReason: '' });
    expect(verdict.allowed === false && verdict.requiresConfirmation).toBe(true);
  });

  it('sends again once someone accepts the risk of a duplicate', () => {
    expect(manualSendAllowed({ status: 'SENT_UNVERIFIED', skipReason: '' }, { confirmDuplicate: true })).toEqual({ allowed: true });
  });

  // While the timed-out provider call may still be running, even an accepted
  // risk is not enough: the first message could still be on its way.
  it('waits for a timed-out send to be over before a second copy is even offered', () => {
    const stillRunning = { status: 'SENT_UNVERIFIED', skipReason: '', sendLockUntil: new Date('2026-09-20T10:01:00.000Z') };
    const verdict = manualSendAllowed(stillRunning, { confirmDuplicate: true, now: new Date('2026-09-20T10:00:00.000Z') });
    expect(verdict.allowed === false && verdict.requiresConfirmation).toBeFalsy();
  });

  it('says why, in words', () => {
    const stillRunning = { status: 'SENT_UNVERIFIED', skipReason: '', sendLockUntil: new Date('2026-09-20T10:01:00.000Z') };
    const verdict = manualSendAllowed(stillRunning, { now: new Date('2026-09-20T10:00:00.000Z') });
    expect(verdict.allowed === false && verdict.reason).toMatch(/has not answered yet/i);
  });

  it('never lets that confirmation resend an email that is already on its way', () => {
    expect(manualSendAllowed({ status: 'SENDING', skipReason: '' }, { confirmDuplicate: true }).allowed).toBe(false);
  });

  it('never lets that confirmation resend a confirmed send', () => {
    expect(manualSendAllowed({ status: 'SENT', skipReason: '' }, { confirmDuplicate: true }).allowed).toBe(false);
  });

  it.each(['WITHDRAWN', 'DECLINED', 'PARTIAL_INTERVIEW', 'NOT_COMPLETED'])('is not offered after a skip for %s', (skipReason) => {
    expect(manualSendAllowed({ status: 'SKIPPED', skipReason }).allowed).toBe(false);
  });
});
