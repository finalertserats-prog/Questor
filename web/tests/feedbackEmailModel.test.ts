import { describe, it, expect } from 'vitest';
import { feedbackEmailSummary, type FeedbackEmailState, type FeedbackEmailRecord } from '../src/components/feedbackEmailModel';

/**
 * What the assessment page says about the candidate's feedback email: that it
 * went and when (with the text behind "View"), that it is on its way, that it
 * failed and why, or why none was sent — and whether "Send feedback now" is
 * offered.
 */

const DATE = (iso: string) => iso.slice(0, 10);

function record(over: Partial<FeedbackEmailRecord> = {}): FeedbackEmailRecord {
  return {
    status: 'SENT', trigger: 'auto', skipReason: '', skipReasonText: null, attempts: 1, lastError: '',
    subject: 'Thank you for your interview for Data Engineer at Acme', bodyText: 'Hi Priya,',
    contentSource: 'evidence', delivered: true, sentAt: '2026-09-19T10:00:00.000Z', nextAttemptAt: null,
    createdAt: '2026-09-19T09:59:00.000Z', ...over,
  };
}

function state(over: Partial<FeedbackEmailState> = {}): FeedbackEmailState {
  return { email: record(), canSendNow: false, blockedReason: 'Feedback has already been sent to this candidate.', ...over };
}

describe('a sent email', () => {
  it('says the feedback was sent and when', () => {
    expect(feedbackEmailSummary(state(), DATE).headline).toBe('Feedback sent to the candidate on 2026-09-19');
  });

  it('offers the text that was sent', () => {
    expect(feedbackEmailSummary(state(), DATE).showText).toBe(true);
  });

  it('does not offer to send it again', () => {
    expect(feedbackEmailSummary(state(), DATE).canSendNow).toBe(false);
  });

  it('says so plainly when the server could only log it', () => {
    expect(feedbackEmailSummary(state({ email: record({ delivered: false }) }), DATE).detail).toMatch(/only logged/);
  });

  it('says who sent it when a person pressed the button', () => {
    expect(feedbackEmailSummary(state({ email: record({ trigger: 'manual' }) }), DATE).detail).toBe('Sent from this page by a member of the hiring team.');
  });
});

describe('an email on its way', () => {
  it('says it is on its way', () => {
    expect(feedbackEmailSummary(state({ email: record({ status: 'QUEUED', sentAt: null, attempts: 0 }) }), DATE).headline)
      .toBe('Feedback email is on its way to the candidate');
  });

  it('says a retry is coming after a failed try', () => {
    const summary = feedbackEmailSummary(state({ email: record({ status: 'QUEUED', sentAt: null, attempts: 2, lastError: 'SMTP 451' }) }), DATE);
    expect(summary.detail).toBe('The last try did not go through (SMTP 451). It will be tried again automatically.');
  });
});

describe('an email that failed', () => {
  const failed = state({ email: record({ status: 'FAILED', sentAt: null, attempts: 5, lastError: 'SMTP 550 mailbox unavailable' }), canSendNow: true, blockedReason: null });

  it('says it could not be sent', () => {
    expect(feedbackEmailSummary(failed, DATE).headline).toBe('The feedback email could not be sent');
  });

  it('gives the reason', () => {
    expect(feedbackEmailSummary(failed, DATE).detail).toBe('SMTP 550 mailbox unavailable');
  });

  it('offers "Send feedback now"', () => {
    expect(feedbackEmailSummary(failed, DATE).canSendNow).toBe(true);
  });
});

describe('no email', () => {
  it('explains a skip', () => {
    const skipped = state({ email: record({ status: 'SKIPPED', sentAt: null, skipReason: 'WITHDRAWN', skipReasonText: 'The candidate withdrew from the interview, so no feedback was sent.' }) });
    expect(feedbackEmailSummary(skipped, DATE)).toMatchObject({
      headline: 'No feedback email was sent', detail: 'The candidate withdrew from the interview, so no feedback was sent.', showText: false,
    });
  });

  it('offers to send one when nothing is on record', () => {
    expect(feedbackEmailSummary(state({ email: null, canSendNow: true, blockedReason: null }), DATE))
      .toMatchObject({ headline: 'No feedback email has been sent to the candidate yet', canSendNow: true });
  });

  it('gives the reason when one cannot be sent', () => {
    expect(feedbackEmailSummary(state({ email: null, canSendNow: false, blockedReason: 'The interview was not completed, so no feedback was sent.' }), DATE).detail)
      .toBe('The interview was not completed, so no feedback was sent.');
  });

  it('treats a previewed but unsent email as not sent', () => {
    expect(feedbackEmailSummary(state({ email: record({ status: 'DRAFT', sentAt: null }), canSendNow: true, blockedReason: null }), DATE).headline)
      .toBe('No feedback email has been sent to the candidate yet');
  });
});
