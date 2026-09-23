import { describe, it, expect } from 'vitest';
import {
  conversationLine, feedbackHeading, feedbackNote, firstName, privacyNoticeHref,
  retentionLine, statusDay, statusHeading, statusSteps, whatHappensNext,
  CANDIDATE_NOTICE_FALLBACK, PRIVACY_ROUTE, type StatusView,
} from '../src/components/candidateStatusModel';

function view(over: Partial<StatusView> = {}): StatusView {
  return {
    candidateName: 'Priya Sharma',
    roleTitle: 'Senior Backend Engineer',
    organisation: 'Northwind Labs',
    interviewer: 'Maya',
    outcome: 'completed',
    timeZone: 'Asia/Kolkata',
    appliedAt: '2026-09-14T06:00:00Z',
    appliedKind: 'application',
    interviewAt: '2026-09-22T12:38:00Z',
    interviewMinutes: 38,
    readByTeamAt: null,
    nextRound: null,
    decisionSharedAt: null,
    feedback: { outlook: 'expected', dueAt: null, sentAt: null },
    talkToAPerson: { requested: false, requestedAt: null },
    retainUntil: '2027-03-21T12:38:00Z',
    ...over,
  };
}

describe('the greeting', () => {
  it('uses the candidate\'s own first name', () => {
    expect(statusHeading(view())).toContain('Priya');
  });

  it('greets someone with a single name without a stray comma', () => {
    expect(firstName('Madonna')).toBe('Madonna');
  });

  it('still reads as a sentence when we have no name at all', () => {
    expect(statusHeading(view({ candidateName: '' }))).toBe('Thank you — that was a good conversation.');
  });

  it('never thanks someone for a good conversation they withdrew from', () => {
    expect(statusHeading(view({ outcome: 'withdrawn' }))).not.toContain('good conversation');
  });

  it('owns a technical failure rather than implying the candidate caused it', () => {
    expect(statusHeading(view({ outcome: 'technical' }))).toContain('on us');
  });
});

describe('how the conversation is described back', () => {
  it('names the interviewer and how long they talked', () => {
    expect(conversationLine(view())).toBe('You talked with Maya for 38 minutes about the Senior Backend Engineer role.');
  });

  it('leaves the length out rather than guessing when it was never recorded', () => {
    expect(conversationLine(view({ interviewMinutes: null }))).not.toMatch(/minutes/);
  });

  it('writes a one-minute conversation as one minute, not "1 minutes"', () => {
    expect(conversationLine(view({ interviewMinutes: 1 }))).toContain('for 1 minute about');
  });

  it('still says something when the interviewer was never named', () => {
    expect(conversationLine(view({ interviewer: null }))).toContain('our AI interviewer');
  });
});

describe('the "where you are" timeline', () => {
  it('walks applied, first conversation, a person reading it, a next conversation and a decision', () => {
    expect(statusSteps(view()).map((s) => s.key))
      .toEqual(['applied', 'interview', 'review', 'next_round', 'decision']);
  });

  it('says "invited" rather than "applied" when an invitation is all we hold', () => {
    expect(statusSteps(view({ appliedKind: 'invitation' }))[0].title).toBe('Invited to interview');
  });

  it('says the date is not recorded rather than printing an empty line', () => {
    expect(statusSteps(view({ appliedAt: null }))[0].detail).toBe('Date not recorded');
  });

  it('marks a person reading it as where the candidate is now', () => {
    const review = statusSteps(view()).find((s) => s.key === 'review');

    expect(review).toMatchObject({ state: 'now', title: 'A person is reading it' });
  });

  it('marks the read as done once a reviewer has completed it', () => {
    const review = statusSteps(view({ readByTeamAt: '2026-09-24T06:00:00Z' })).find((s) => s.key === 'review');

    expect(review).toMatchObject({ state: 'done', title: 'Read by the hiring team' });
  });

  it('keeps a decision in the future until it has actually been shared', () => {
    const decision = statusSteps(view()).find((s) => s.key === 'decision');

    expect(decision?.state).toBe('later');
  });

  it('names the people for a booked next conversation', () => {
    const steps = statusSteps(view({
      nextRound: { scheduledAt: '2026-09-29T06:00:00Z', timeZone: 'Asia/Kolkata', text: 'Tue 29 Sep, 11:30 IST', interviewers: ['Rahul'], booked: true },
    }));

    expect(steps.find((s) => s.key === 'next_round')).toMatchObject({
      title: 'A conversation with Rahul',
      state: 'now',
    });
  });

  it('says the details are still coming when the round has no meeting yet', () => {
    const steps = statusSteps(view({
      nextRound: { scheduledAt: '2026-09-29T06:00:00Z', timeZone: null, text: 'Tue 29 Sep, 11:30 IST', interviewers: [], booked: false },
    }));

    expect(steps.find((s) => s.key === 'next_round')?.detail).toContain('send you the details');
  });

  it('shortens the timeline, and never promises a decision, when the interview did not finish', () => {
    const steps = statusSteps(view({ outcome: 'withdrawn' }));

    expect(steps.map((s) => s.key)).toEqual(['applied', 'ended']);
    expect(steps[1].detail).toContain('does not count against you');
    expect(whatHappensNext(view({ outcome: 'withdrawn' }))).not.toBe(steps[1].detail);
  });

  it('never carries a score, a verdict or a competency into the timeline', () => {
    const printed = JSON.stringify(statusSteps(view({ readByTeamAt: '2026-09-24T06:00:00Z' })));

    expect(printed).not.toMatch(/PROCEED|CONSIDER|DO_NOT_PROGRESS|score|competenc/i);
  });
});

describe('what happens next', () => {
  it('gives the booked time when there is one', () => {
    const line = whatHappensNext(view({
      nextRound: { scheduledAt: '2026-09-29T06:00:00Z', timeZone: null, text: 'Tue 29 Sep, 11:30 IST', interviewers: ['Rahul'], booked: true },
    }));

    expect(line).toContain('Tue 29 Sep, 11:30 IST');
  });

  it('says a person is reading it, rather than inventing a date, when there is none', () => {
    expect(whatHappensNext(view())).toContain('reading your interview now');
  });
});

describe('what the page says about written feedback', () => {
  it('says plainly that this employer does not send it, naming them', () => {
    const note = feedbackNote(view({ feedback: { outlook: 'not_offered', dueAt: null, sentAt: null } }));

    expect(note).toContain('Northwind Labs does not send written feedback');
    expect(note).not.toMatch(/soon|shortly|on its way/);
  });

  it('honours a recorded no without promising anything', () => {
    const note = feedbackNote(view({ feedback: { outlook: 'declined', dueAt: null, sentAt: null } }));

    expect(note).toContain('would rather not have written feedback');
  });

  it('gives the date when there is one', () => {
    const note = feedbackNote(view({ feedback: { outlook: 'expected', dueAt: '2026-09-24T06:00:00Z', sentAt: null } }));

    expect(note).toMatch(/Thu 24 Sept?/);
  });

  it('invents no date when a person is still reading', () => {
    const note = feedbackNote(view({ feedback: { outlook: 'with_a_person', dueAt: null, sentAt: null } }));

    expect(note).toContain('no date to give you yet');
    expect(note).not.toMatch(/\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
  });

  it('says it is loading while the letter itself is still being fetched', () => {
    const note = feedbackNote(view({ feedback: { outlook: 'arrived', dueAt: null, sentAt: '2026-09-24T06:00:00Z' } }), true);

    expect(note).toBe('Loading your feedback…');
  });

  it('never leaves an empty box under "feedback from your conversation"', () => {
    const note = feedbackNote(view({ feedback: { outlook: 'arrived', dueAt: null, sentAt: '2026-09-24T06:00:00Z' } }));

    expect(note).toContain('sent to you by email');
    expect(note).not.toBe('');
  });

  it('changes the heading once the words are there to read', () => {
    expect(feedbackHeading('arrived')).toBe('Feedback from your conversation');
    expect(feedbackHeading('expected')).toBe('Your feedback');
  });
});

describe('what is kept, and for how long', () => {
  it('gives the deletion date and says it is a transcript, not a recording', () => {
    const line = retentionLine(view());

    expect(line).toContain('not a recording');
    expect(line).toMatch(/21 Mar/);
  });

  it('links the privacy page when the app has one', () => {
    expect(privacyNoticeHref(true)).toBe(PRIVACY_ROUTE);
  });

  it('falls back to the existing notice rather than a dead route', () => {
    expect(privacyNoticeHref(false)).toBe(CANDIDATE_NOTICE_FALLBACK);
  });
});

describe('dates on the clock the interview was booked on', () => {
  it('writes the day in the interview\'s own zone, not the reader\'s', () => {
    // 18:38 in Kolkata is still the 22nd; in UTC it is 13:08 the same day, but
    // an hour later in Kolkata it would roll over and UTC would not.
    expect(statusDay('2026-09-22T19:30:00Z', 'Asia/Kolkata')).toMatch(/^Wed 23 Sept?$/);
  });

  it('survives a zone this browser has never heard of', () => {
    expect(statusDay('2026-09-22T12:38:00Z', 'Mars/Olympus')).toBeTruthy();
  });

  it('prints nothing for a date we do not have', () => {
    expect(statusDay(null, 'Asia/Kolkata')).toBe('');
  });
});
