import { describe, it, expect } from 'vitest';
import {
  MAX_SEND_ATTEMPTS, afterFailedAttempt, autoCandidateFeedbackEnabled, blindReviewRequired,
  feedbackEligibility, manualSendAllowed, retryDelayMs, type EligibilityInput,
} from '../src/services/autoFeedbackModel.js';

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

  it.each(['FAILED', 'DRAFT'])('is offered for a %s email', (status) => {
    expect(manualSendAllowed({ status, skipReason: '' })).toEqual({ allowed: true });
  });

  it.each(['POLICY_OFF', 'NO_EMAIL', 'DEMO_RECIPIENT', 'NO_ASSESSMENT'])('is offered after a skip for %s', (skipReason) => {
    expect(manualSendAllowed({ status: 'SKIPPED', skipReason })).toEqual({ allowed: true });
  });

  it.each(['SENT', 'SENDING', 'QUEUED'])('is not offered once the email is %s', (status) => {
    expect(manualSendAllowed({ status, skipReason: '' }).allowed).toBe(false);
  });

  it.each(['WITHDRAWN', 'DECLINED', 'PARTIAL_INTERVIEW', 'NOT_COMPLETED'])('is not offered after a skip for %s', (skipReason) => {
    expect(manualSendAllowed({ status: 'SKIPPED', skipReason }).allowed).toBe(false);
  });
});
