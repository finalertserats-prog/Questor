import { prisma } from '../db.js';
import { config } from '../config.js';
import type { EmailAttachment } from '../providers/email/index.js';
import { calendarAttachment, roundCalendarUid, sessionCalendarUid, type CalendarMethod } from './calendarInvite.js';

/**
 * The stored half of the calendar invitation: the sequence counter that makes
 * an update an update, and the two ways of turning a booking into an .ics.
 *
 * Kept apart from calendarInvite.ts so that the format itself stays a pure
 * function of its inputs — the part with the fiddly rules is the part worth
 * being able to test without a database.
 */

/**
 * The address the invitation is organised by. The product's own sending
 * address, never a person's: this is a booking made by Questor on the hiring
 * team's behalf, and a reply to it reaches nobody who is listening.
 */
function organizerAddress(): string {
  // `EMAIL_FROM` is usually "Name <address>"; a calendar ORGANIZER takes the
  // address alone and treats the rest as part of the mailbox if it is left in.
  const match = /<([^>]+)>/.exec(config.email.from);
  return (match?.[1] ?? config.email.from).trim();
}

/**
 * Take the sequence number this message goes out under, and move the counter on.
 *
 * Numbered from zero, and claimed before the send rather than after, so a send
 * that fails still burns its number: a later message with a number already used
 * is precisely what a calendar client is entitled to ignore.
 */
async function claimSequence(kind: 'round' | 'session', id: string): Promise<number> {
  const after = kind === 'round'
    ? await prisma.interviewRound.update({ where: { id }, data: { calendarSequence: { increment: 1 } }, select: { calendarSequence: true } })
    : await prisma.interviewSession.update({ where: { id }, data: { calendarSequence: { increment: 1 } }, select: { calendarSequence: true } });
  return after.calendarSequence - 1;
}

export interface RecipientInvite {
  readonly recipientName: string;
  readonly recipientEmail: string;
  /**
   * What this recipient's calendar will show. Per-recipient on purpose: an
   * expert conducting a round must not receive an entry naming the candidate,
   * which would put that name (and, through ATTENDEE, their address) into a
   * personal calendar the hiring team does not control. The candidate's own
   * copy may of course name the company and the role.
   */
  readonly summary: string;
  readonly description: string;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly durationMinutes: number;
  readonly method: CalendarMethod;
  readonly organizerName: string;
}

/** The invitation for one recipient of one pipeline round. */
export async function roundCalendarAttachment(roundId: string, invite: RecipientInvite): Promise<EmailAttachment> {
  return calendarAttachment({
    ...invite,
    uid: roundCalendarUid(roundId),
    sequence: await claimSequence('round', roundId),
    organizerEmail: organizerAddress(),
  });
}

/** The invitation for one recipient of one AI interview. */
export async function sessionCalendarAttachment(sessionId: string, invite: RecipientInvite): Promise<EmailAttachment> {
  return calendarAttachment({
    ...invite,
    uid: sessionCalendarUid(sessionId),
    sequence: await claimSequence('session', sessionId),
    organizerEmail: organizerAddress(),
  });
}
