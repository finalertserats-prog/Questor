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
  return {
    email: record(), canSendNow: false, needsDuplicateConfirmation: false,
    blockedReason: 'Feedback has already been sent to this candidate.', ...over,
  };
}

// A send that reached the mail provider but could not claim its own row back:
// the candidate may well have it, so the page must not quietly offer to send
// another copy.
const UNVERIFIED_REASON = 'This feedback email may already have reached the candidate: the send was interrupted '
  + 'before it could be confirmed. Check with them before sending it again.';

const UNVERIFIED = () => state({
  email: record({ status: 'SENT_UNVERIFIED', lastError: UNVERIFIED_REASON }),
  canSendNow: false,
  needsDuplicateConfirmation: true,
  blockedReason: UNVERIFIED_REASON,
});

describe('a send that could not be confirmed', () => {
  it('says it may have reached the candidate rather than that it failed', () => {
    expect(feedbackEmailSummary(UNVERIFIED(), DATE).headline).toBe('The feedback email may have reached the candidate');
  });

  it('gives the reason to check before sending again', () => {
    expect(feedbackEmailSummary(UNVERIFIED(), DATE).detail).toBe(UNVERIFIED_REASON);
  });

  it('still shows the text that went', () => {
    expect(feedbackEmailSummary(UNVERIFIED(), DATE).showText).toBe(true);
  });

  it('does not offer a plain "Send feedback now"', () => {
    expect(feedbackEmailSummary(UNVERIFIED(), DATE).canSendNow).toBe(false);
  });

  it('offers sending again only behind an acceptance of the risk', () => {
    expect(feedbackEmailSummary(UNVERIFIED(), DATE).needsDuplicateConfirmation).toBe(true);
  });

  it('asks for no such acceptance anywhere else', () => {
    expect(feedbackEmailSummary(state(), DATE).needsDuplicateConfirmation).toBe(false);
  });
});

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

// Held because the interview could not be relied on (owner, 2026-09-22): the
// page says why in plain words and offers the decision only to someone who
// may make it.
describe('a held email', () => {
  const REASONS = ['The AI was only 25% confident in its assessment (the email is held below 35%).'];
  const held = (over: Partial<FeedbackEmailState> = {}, keptAt: string | null = null) => state({
    email: record({
      status: 'HELD', sentAt: null,
      hold: { reasons: ['LOW_AI_CONFIDENCE'], reasonTexts: REASONS, heldAt: '2026-09-22T09:00:00.000Z', keptAt, keptByUserId: keptAt ? 'u1' : null },
    }),
    canSendNow: true, blockedReason: null, canDecideHold: true, ...over,
  });

  it('says it is waiting for a decision', () => {
    expect(feedbackEmailSummary(held(), DATE).headline).toBe('Feedback email held for your decision');
  });

  it('lists the reasons in plain words', () => {
    expect(feedbackEmailSummary(held(), DATE).holdReasons).toEqual(REASONS);
  });

  it('explains why it was not sent on its own', () => {
    expect(feedbackEmailSummary(held(), DATE).detail).toContain('was not sent automatically');
  });

  it('offers release and keep-holding to someone who may decide', () => {
    const s = feedbackEmailSummary(held(), DATE);
    expect([s.canRelease, s.canKeepHolding]).toEqual([true, true]);
  });

  it('offers neither to someone who may not decide', () => {
    const s = feedbackEmailSummary(held({ canDecideHold: false }), DATE);
    expect([s.canRelease, s.canKeepHolding]).toEqual([false, false]);
  });

  it('does not show the ordinary send button beside the hold controls', () => {
    expect(feedbackEmailSummary(held(), DATE).canSendNow).toBe(false);
  });

  it('says when someone has chosen to keep it held', () => {
    expect(feedbackEmailSummary(held({}, '2026-09-22T10:00:00.000Z'), DATE).headline).toBe('Feedback email kept on hold on 2026-09-22');
  });

  it('still offers release after it was kept, but not keeping it again', () => {
    const s = feedbackEmailSummary(held({}, '2026-09-22T10:00:00.000Z'), DATE);
    expect([s.canRelease, s.canKeepHolding]).toEqual([true, false]);
  });

  it('has no reasons to list for an email that was never held', () => {
    expect(feedbackEmailSummary(state(), DATE).holdReasons).toEqual([]);
  });
});
