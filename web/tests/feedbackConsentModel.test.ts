import { describe, it, expect } from 'vitest';
import {
  consentSummary, requestAction, sendAction, type FeedbackConsent,
} from '../src/components/feedbackConsentModel';

const NOT_ASKED_REASON = 'Candidate was not asked whether they want written feedback, so it cannot be sent yet. Send them a request to opt in first.';
const DECLINED_REASON = 'Candidate declined written feedback, so it cannot be sent to them.';

function consent(over: Partial<FeedbackConsent> = {}): FeedbackConsent {
  return {
    status: 'NOT_ASKED',
    canSend: false,
    blockReason: NOT_ASKED_REASON,
    canRequest: true,
    requestBlockReason: null,
    request: null,
    ...over,
  };
}

const optedIn = () => consent({ status: 'OPTED_IN', canSend: true, blockReason: null, canRequest: false, requestBlockReason: 'Candidate has already opted in.' });
const declined = () => consent({ status: 'DECLINED', blockReason: DECLINED_REASON, canRequest: false, requestBlockReason: 'Candidate declined written feedback, and is not asked again.' });

describe('consentSummary', () => {
  it('says a never-asked candidate was not asked', () => {
    expect(consentSummary(consent()).label).toBe('Candidate was not asked');
  });

  it('says a declined candidate declined', () => {
    expect(consentSummary(declined()).label).toBe('Candidate declined');
  });

  it('says an opted-in candidate asked for feedback', () => {
    expect(consentSummary(optedIn()).label).toBe('Candidate opted in');
  });

  it('marks the three states with different tones', () => {
    const tones = [consent(), declined(), optedIn()].map((c) => consentSummary(c).tone);
    expect(new Set(tones).size).toBe(3);
  });

  it('mentions a request that is out and waiting', () => {
    const summary = consentSummary(consent({ request: { issuedAt: '2026-09-01T10:00:00Z', expiresAt: '2026-10-01T10:00:00Z' } }));
    expect(summary.detail).toMatch(/request .* sent/i);
  });
});

describe('sendAction', () => {
  it('is disabled with the server\'s reason when the candidate was not asked', () => {
    expect(sendAction({ consent: consent(), feedbackStatus: 'APPROVED', busy: false }))
      .toEqual({ disabled: true, reason: NOT_ASKED_REASON });
  });

  it('is disabled with the server\'s reason when the candidate declined', () => {
    expect(sendAction({ consent: declined(), feedbackStatus: 'APPROVED', busy: false }))
      .toEqual({ disabled: true, reason: DECLINED_REASON });
  });

  it('puts the consent reason ahead of the approval one, since approving will not fix it', () => {
    expect(sendAction({ consent: declined(), feedbackStatus: 'DRAFT', busy: false }).reason).toBe(DECLINED_REASON);
  });

  it('asks for approval first when the candidate opted in but nothing is approved', () => {
    expect(sendAction({ consent: optedIn(), feedbackStatus: 'DRAFT', busy: false }))
      .toEqual({ disabled: true, reason: 'Approve the feedback before sending it.' });
  });

  it('is enabled for approved feedback to a candidate who opted in', () => {
    expect(sendAction({ consent: optedIn(), feedbackStatus: 'APPROVED', busy: false })).toEqual({ disabled: false, reason: null });
  });

  it('is disabled while another action is running', () => {
    expect(sendAction({ consent: optedIn(), feedbackStatus: 'APPROVED', busy: true }).disabled).toBe(true);
  });

  it('is disabled once sent', () => {
    expect(sendAction({ consent: optedIn(), feedbackStatus: 'SENT', busy: false }))
      .toEqual({ disabled: true, reason: 'Already sent.' });
  });
});

describe('requestAction', () => {
  it('offers to ask a candidate who was never asked', () => {
    expect(requestAction(consent())).toEqual({ visible: true, label: 'Ask the candidate', note: null });
  });

  it('offers to send it again once a request is out', () => {
    const action = requestAction(consent({ request: { issuedAt: '2026-09-01T10:00:00Z', expiresAt: '2026-10-01T10:00:00Z' } }));
    expect(action.label).toBe('Send the request again');
  });

  it('is not offered to a candidate who declined', () => {
    expect(requestAction(declined()).visible).toBe(false);
  });

  it('is not offered to a candidate who already opted in', () => {
    expect(requestAction(optedIn()).visible).toBe(false);
  });

  it('explains why it cannot be offered for a never-asked candidate', () => {
    const blocked = consent({ canRequest: false, requestBlockReason: 'The interview has not finished yet.' });
    expect(requestAction(blocked)).toEqual({ visible: false, label: 'Ask the candidate', note: 'The interview has not finished yet.' });
  });
});
