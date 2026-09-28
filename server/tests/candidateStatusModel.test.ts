import { describe, it, expect } from 'vitest';
import {
  feedbackOutlook,
  interviewMinutes,
  linkStillLeadsToInterview,
  retentionUntil,
  statusOutcome,
  type FeedbackInput,
} from '../src/domain/candidateStatusModel.js';

describe('what the candidate is told happened to their interview', () => {
  it('calls a finished interview completed', () => {
    expect(statusOutcome('REVIEW_READY', new Date())).toBe('completed');
  });

  it('calls a closed interview that never finished incomplete, not completed', () => {
    expect(statusOutcome('CLOSED', null)).toBe('incomplete');
  });

  it('names a withdrawal as the candidate ending it, never as a failure', () => {
    expect(statusOutcome('CANDIDATE_WITHDREW', null)).toBe('withdrawn');
  });

  it('owns a technical failure as ours', () => {
    expect(statusOutcome('TECHNICAL_FAILURE', null)).toBe('technical');
  });

  it('treats a handoff as a person taking over', () => {
    expect(statusOutcome('MANUAL_HANDOFF', null)).toBe('handoff');
  });

  it('falls back to closed for a state it does not know', () => {
    expect(statusOutcome('SOMETHING_NEWER', null)).toBe('closed');
  });
});

describe('whether the link is still an invitation', () => {
  it('is, before the interview', () => {
    expect(linkStillLeadsToInterview('INVITED', null)).toBe(true);
    expect(linkStillLeadsToInterview('CONSENTED', null)).toBe(true);
  });

  it('is, while the interview is running', () => {
    expect(linkStillLeadsToInterview('ASSESSING', null)).toBe(true);
    expect(linkStillLeadsToInterview('WARMUP', null)).toBe(true);
  });

  it('is not, once the interview has finished', () => {
    expect(linkStillLeadsToInterview('REVIEW_READY', new Date())).toBe(false);
  });

  it('is not, whatever state a finished interview was left in', () => {
    expect(linkStillLeadsToInterview('ASSESSING', new Date())).toBe(false);
  });

  it('is not, once the candidate has stopped it', () => {
    expect(linkStillLeadsToInterview('CANDIDATE_WITHDREW', null)).toBe(false);
  });
});

describe('how long the conversation lasted', () => {
  it('rounds the gap between starting and finishing to whole minutes', () => {
    const started = new Date('2026-09-22T10:00:00Z');
    const completed = new Date('2026-09-22T10:38:20Z');

    expect(interviewMinutes(started, completed)).toBe(38);
  });

  it('says nothing rather than guessing when the start was never recorded', () => {
    expect(interviewMinutes(null, new Date())).toBeNull();
  });

  it('says nothing rather than reporting a negative length from clock skew', () => {
    const started = new Date('2026-09-22T10:38:00Z');
    const completed = new Date('2026-09-22T10:00:00Z');

    expect(interviewMinutes(started, completed)).toBeNull();
  });

  it('never reports a conversation as zero minutes long', () => {
    const started = new Date('2026-09-22T10:00:00Z');
    const completed = new Date('2026-09-22T10:00:20Z');

    expect(interviewMinutes(started, completed)).toBe(1);
  });
});

function feedbackFacts(over: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    outcome: 'completed',
    approvedFlowEnabled: false,
    autoEmailEnabled: true,
    optInChoice: null,
    delivery: null,
    autoEmail: null,
    ...over,
  };
}

describe('what the candidate is told about written feedback', () => {
  it('says plainly that this employer does not send written feedback when both paths are off', () => {
    const out = feedbackOutlook(feedbackFacts({ approvedFlowEnabled: false, autoEmailEnabled: false }));

    expect(out.outlook).toBe('not_offered');
  });

  it('honours a recorded no rather than promising a letter', () => {
    const out = feedbackOutlook(feedbackFacts({ optInChoice: 'NO' }));

    expect(out.outlook).toBe('declined');
  });

  it('shows the letter once a person has approved and sent it', () => {
    const sentAt = new Date('2026-09-24T09:00:00Z');
    const out = feedbackOutlook(feedbackFacts({ delivery: { status: 'SENT', sentAt } }));

    expect(out).toMatchObject({ outlook: 'arrived', sentAt });
  });

  it('shows the letter once the automatic email has gone', () => {
    const sentAt = new Date('2026-09-24T09:00:00Z');
    const out = feedbackOutlook(feedbackFacts({ autoEmail: { status: 'SENT', sentAt, nextAttemptAt: null } }));

    expect(out).toMatchObject({ outlook: 'arrived', sentAt });
  });

  it('treats an interrupted send as arrived, because the candidate may already have it', () => {
    const sentAt = new Date('2026-09-24T09:00:00Z');
    const out = feedbackOutlook(feedbackFacts({ autoEmail: { status: 'SENT_UNVERIFIED', sentAt, nextAttemptAt: null } }));

    expect(out.outlook).toBe('arrived');
  });

  it('gives the date it is due when the letter is queued', () => {
    const due = new Date('2026-09-24T09:00:00Z');
    const out = feedbackOutlook(feedbackFacts({ autoEmail: { status: 'QUEUED', sentAt: null, nextAttemptAt: due } }));

    expect(out).toMatchObject({ outlook: 'expected', dueAt: due });
  });

  it('says a person is still looking, and invents no date, when the letter is held', () => {
    const out = feedbackOutlook(feedbackFacts({
      autoEmail: { status: 'HELD', sentAt: null, nextAttemptAt: new Date('2026-09-24T09:00:00Z') },
    }));

    expect(out).toMatchObject({ outlook: 'with_a_person', dueAt: null });
  });

  it('says a person is still looking while a draft waits for approval', () => {
    const out = feedbackOutlook(feedbackFacts({
      approvedFlowEnabled: true,
      autoEmailEnabled: false,
      optInChoice: 'YES',
      delivery: { status: 'DRAFT', sentAt: null },
    }));

    expect(out).toMatchObject({ outlook: 'with_a_person', dueAt: null });
  });

  it('promises nothing when the interview never finished', () => {
    const out = feedbackOutlook(feedbackFacts({ outcome: 'withdrawn' }));

    expect(out.outlook).toBe('none');
  });

  it('never reports a send that was skipped as one that is coming', () => {
    const out = feedbackOutlook(feedbackFacts({
      autoEmail: { status: 'SKIPPED', sentAt: null, nextAttemptAt: null },
    }));

    expect(out.outlook).toBe('none');
  });

  it('says the letter is on its way when the automatic email is switched on and nothing is on file yet', () => {
    const out = feedbackOutlook(feedbackFacts());

    expect(out).toMatchObject({ outlook: 'expected', dueAt: null });
  });
});

describe('how long what we keep is kept', () => {
  it('uses the date set on the interview when there is one', () => {
    const until = new Date('2027-03-20T00:00:00Z');

    expect(retentionUntil({ retainUntil: until, completedAt: new Date(), createdAt: new Date() }, 180)).toBe(until);
  });

  it('counts the default window from the end of the interview when no date was set', () => {
    const completedAt = new Date('2026-09-22T10:00:00Z');

    expect(retentionUntil({ retainUntil: null, completedAt, createdAt: new Date('2026-09-01T00:00:00Z') }, 180))
      .toEqual(new Date('2027-03-21T10:00:00Z'));
  });

  it('counts from when the interview was set up when it never finished', () => {
    const createdAt = new Date('2026-09-01T00:00:00Z');

    expect(retentionUntil({ retainUntil: null, completedAt: null, createdAt }, 180))
      .toEqual(new Date('2027-02-28T00:00:00Z'));
  });
});
