import type { InterviewRound, InterviewSession } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import type { EmailAttachment } from '../providers/email/index.js';
import { calendarAttachment, roundCalendarUid, sessionCalendarUid, type CalendarMethod } from './calendarInvite.js';

/**
 * The stored half of the calendar invitation: the sequence counter that makes
 * an update an update, and the row state that number is a statement about.
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
 * A sequence number AND the row it is a statement about, read as one write.
 *
 * WHY THEY COME BACK TOGETHER. A calendar client is told to prefer the highest
 * SEQUENCE it has seen for a UID. So if the number is claimed independently of
 * the row it describes, two people moving the same round at once can leave a
 * recipient on the time neither of them chose last: A writes 15:00, B writes
 * 16:00 and sends under sequence 2, A — delayed — claims sequence 3 and sends
 * its stale 15:00, and the calendar dutifully reverts.
 *
 * `UPDATE ... RETURNING` is one statement, so the number and the state are
 * taken under the same row lock. Claims therefore serialise, and a later claim
 * can only ever see a state at least as new as an earlier one's: the highest
 * sequence always describes the newest state any sender saw. The caller must
 * describe the row it gets back here, not the one it was holding.
 */
export interface ClaimedRoundCalendar {
  readonly sequence: number;
  readonly round: InterviewRound;
}

export interface ClaimedSessionCalendar {
  readonly sequence: number;
  readonly session: InterviewSession;
}

/**
 * Numbered from zero, and claimed before the send rather than after, so a send
 * that fails still burns its number: a later message reusing a number already
 * spent is precisely what a calendar client is entitled to ignore.
 */
export async function claimRoundCalendar(roundId: string): Promise<ClaimedRoundCalendar> {
  const round = await prisma.interviewRound.update({ where: { id: roundId }, data: { calendarSequence: { increment: 1 } } });
  return { sequence: round.calendarSequence - 1, round };
}

export async function claimSessionCalendar(sessionId: string): Promise<ClaimedSessionCalendar> {
  const session = await prisma.interviewSession.update({ where: { id: sessionId }, data: { calendarSequence: { increment: 1 } } });
  return { sequence: session.calendarSequence - 1, session };
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

/** One recipient's copy of a pipeline round's entry, under a claimed sequence. */
export function roundInviteAttachment(claimed: ClaimedRoundCalendar, invite: RecipientInvite): EmailAttachment {
  return calendarAttachment({
    ...invite, uid: roundCalendarUid(claimed.round.id), sequence: claimed.sequence, organizerEmail: organizerAddress(),
  });
}

/** One recipient's copy of an AI interview's entry, under a claimed sequence. */
export function sessionInviteAttachment(claimed: ClaimedSessionCalendar, invite: RecipientInvite): EmailAttachment {
  return calendarAttachment({
    ...invite, uid: sessionCalendarUid(claimed.session.id), sequence: claimed.sequence, organizerEmail: organizerAddress(),
  });
}
