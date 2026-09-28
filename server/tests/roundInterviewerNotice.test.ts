import { describe, it, expect } from 'vitest';
import { buildRoundInterviewerEmail } from '../src/services/roundInterviewerNotice.js';

/**
 * The letter the person conducting a round gets.
 *
 * Booking a round emailed the person who pressed the button and nobody else, so
 * an expert seated on a Gold round found out only if a colleague told them. The
 * letter below is written for the interviewer, which is a different message
 * from the booker's confirmation: it tells them they are conducting something.
 *
 * An email cannot be recalled, so every later change to the round has a letter
 * too. A move names the time it WAS as well as the time it now is: an
 * interviewer holding a time nobody has contradicted will turn up at it.
 */

const seatedBase = {
  kind: 'seated' as const,
  seated: 'conducting' as const,
  stageLabel: 'Gold',
  scheduledAt: new Date('2026-10-08T09:00:00.000Z'),
  timeZone: 'Asia/Kolkata',
  durationMinutes: 45,
  meetingUrl: null as string | null,
  link: 'https://app.example.com/candidates/c1' as string | null,
  previousWhen: null as string | null,
  aiRound: false,
};

describe('the email a seated interviewer gets', () => {
  it('tells them they are conducting it, not that a booking of theirs is confirmed', () => {
    expect(buildRoundInterviewerEmail({ ...seatedBase }).text).toContain('conduct');
  });

  it('names the stage in the subject', () => {
    expect(buildRoundInterviewerEmail({ ...seatedBase }).subject).toContain('Gold');
  });

  it('carries the time in the zone the round was booked in', () => {
    expect(buildRoundInterviewerEmail({ ...seatedBase }).text).toContain('UTC');
  });

  it('carries the meeting link when the round has one', () => {
    const mail = buildRoundInterviewerEmail({ ...seatedBase, meetingUrl: 'https://meet.example.com/abc' });
    expect(mail.text).toContain('https://meet.example.com/abc');
  });

  it('strips control characters out of a configurable stage label before the subject line', () => {
    const mail = buildRoundInterviewerEmail({ ...seatedBase, stageLabel: 'Gold\r\nBcc: someone@evil.test' });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('strips control characters out of a stage label before the plain-text body too', () => {
    const mail = buildRoundInterviewerEmail({ ...seatedBase, stageLabel: `Gold${String.fromCharCode(7)}${String.fromCharCode(27)}X` });
    expect(mail.text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  });

  it('escapes the link into the HTML body rather than writing it raw', () => {
    const mail = buildRoundInterviewerEmail({ ...seatedBase, link: 'https://app.example.com/candidates/c1?a=1&b=2' });
    expect(mail.html).toContain('a=1&amp;b=2');
  });

  it('leaves out the page link for someone whose role can open no page for this candidate', () => {
    expect(buildRoundInterviewerEmail({ ...seatedBase, link: null }).text).not.toContain('https://app.example.com');
  });

});

/**
 * Being seated means three different things, and the round decides which. The
 * owner's rule (2026-09-25): a human observer on an AI interview is optional,
 * what the expert owes is the review, and an expert can be brought in after
 * the round is over.
 */
describe('what the seat is actually asking for', () => {
  const observing = { ...seatedBase, seated: 'observing' as const, aiRound: true };
  const reviewing = { ...seatedBase, seated: 'reviewing' as const };

  it('invites an observer on an AI round rather than summoning them', () => {
    expect(buildRoundInterviewerEmail(observing).subject).toContain('invited');
  });

  it('tells the observer that joining is their own call', () => {
    expect(buildRoundInterviewerEmail(observing).text).toMatch(/up to you/i);
  });

  it('still asks the observer for the assessment, which is what they owe either way', () => {
    expect(buildRoundInterviewerEmail(observing).text).toMatch(/assessment/i);
  });

  it('asks for a read, not an attendance, when the round has already happened', () => {
    expect(buildRoundInterviewerEmail(reviewing).text).not.toMatch(/you are down to conduct/i);
  });

  it('points at the recording and transcript for a round already over', () => {
    expect(buildRoundInterviewerEmail(reviewing).text).toMatch(/recording and transcript/i);
  });

  it('offers no meeting to join for a round already over', () => {
    const mail = buildRoundInterviewerEmail({ ...reviewing, meetingUrl: 'https://meet.example.com/abc' });
    expect(mail.text).not.toContain('https://meet.example.com/abc');
  });
});

describe('the email when the round changes', () => {
  it('says the time it was as well as the time it now is', () => {
    const mail = buildRoundInterviewerEmail({ ...seatedBase, kind: 'moved', previousWhen: '07 Oct 2026, 14:30' });
    expect(mail.text).toContain('07 Oct 2026, 14:30');
  });

  it('says in the subject that it moved', () => {
    expect(buildRoundInterviewerEmail({ ...seatedBase, kind: 'moved', previousWhen: '07 Oct 2026, 14:30' }).subject).toContain('moved');
  });

  it('says plainly that a cancelled round is cancelled', () => {
    expect(buildRoundInterviewerEmail({ ...seatedBase, kind: 'cancelled' }).text).toContain('cancelled');
  });

  it('offers no meeting link on a cancellation, because the meeting is gone', () => {
    const mail = buildRoundInterviewerEmail({ ...seatedBase, kind: 'cancelled', meetingUrl: 'https://meet.example.com/abc' });
    expect(mail.text).not.toContain('https://meet.example.com/abc');
  });

  it('carries the link that did not exist when the round was booked', () => {
    const mail = buildRoundInterviewerEmail({ ...seatedBase, kind: 'link', meetingUrl: 'https://meet.example.com/late' });
    expect(mail.text).toContain('https://meet.example.com/late');
  });
});

describe('what the interviewer letter never carries', () => {
  // The letter goes to an inbox Questor does not control, and a seated expert
  // is not entitled to the candidate's address on any surface. The link carries
  // who the candidate is, behind the reader's own sign-in.
  it('names no candidate and no candidate address anywhere in it', () => {
    const mail = buildRoundInterviewerEmail({ ...seatedBase, meetingUrl: 'https://meet.example.com/abc' });
    expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toMatch(/@example\.com|Priya/i);
  });
});
