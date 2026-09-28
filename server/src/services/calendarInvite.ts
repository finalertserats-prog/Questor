import type { EmailAttachment } from '../providers/email/index.js';

/**
 * The calendar attachment that goes with a scheduling email.
 *
 * WHY AT ALL. An email cannot know what zone its reader is in. It can name the
 * zone the interview was booked in, and this product does — but the reader
 * still has to convert. A calendar entry sidesteps the whole problem, because
 * the recipient's own application renders the instant on their own clock.
 *
 * WHY ONE PER RECIPIENT. A single .ics listing everybody as ATTENDEE would put
 * the candidate's name and address into the interviewer's calendar and the
 * interviewer's into the candidate's — undoing by a side door exactly what the
 * meeting providers go out of their way to prevent (googleMeet.ts sends no
 * invitations, teams.ts adds no attendees). Each copy names only the person it
 * is for, and the caller decides what that person is allowed to be told in the
 * summary and description.
 *
 * WHY UTC. DTSTART in UTC needs no VTIMEZONE, and a VTIMEZONE is the one part
 * of this format where a daylight-saving rule can be written down wrongly. The
 * instant is unambiguous; the reader's client already knows their own rules.
 */

export type CalendarMethod = 'REQUEST' | 'CANCEL';

export interface CalendarInvite {
  /**
   * Stable for the lifetime of the interview. A fresh UID on a reschedule does
   * not move the entry — it adds a second one, and the recipient is left with
   * two interviews and no way to tell which is real.
   */
  readonly uid: string;
  /**
   * Raised on every change that goes out. Outlook silently discards an update
   * whose SEQUENCE did not move, so a correct body with a stale sequence looks
   * exactly like a successful send and changes nothing on the reader's calendar.
   */
  readonly sequence: number;
  readonly method: CalendarMethod;
  readonly startsAt: Date;
  readonly durationMinutes: number;
  /** What the recipient sees as the entry's title — never more than they may know. */
  readonly summary: string;
  readonly description: string;
  /** The meeting link, when there is one this recipient may have. */
  readonly location: string | null;
  readonly organizerName: string;
  readonly organizerEmail: string;
  readonly recipientName: string;
  readonly recipientEmail: string;
  /** Overridable so a test is not a clock. */
  readonly stamp?: Date;
}

/**
 * The domain half of a UID. A literal, not config.webOrigin: a UID has to
 * outlive a deployment moving to a new host, and one that changed with the host
 * would duplicate every future entry instead of updating it.
 */
const UID_DOMAIN = 'questor.invite';

/** The calendar identity of a pipeline round. */
export function roundCalendarUid(roundId: string): string {
  return `round-${roundId}@${UID_DOMAIN}`;
}

/** The calendar identity of an AI interview. Never equal to a round's, even for equal ids. */
export function sessionCalendarUid(sessionId: string): string {
  return `interview-${sessionId}@${UID_DOMAIN}`;
}

/** "20261001T090000Z" — the format DTSTART, DTEND and DTSTAMP take in UTC. */
function utcStamp(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

/**
 * RFC 5545 §3.3.11. The backslash goes first, or the escapes this adds would
 * themselves be escaped by the later passes.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const MAX_OCTETS = 75;

/**
 * Fold one content line to 75 octets, continuations starting with a space.
 *
 * Counted in octets rather than characters because the limit is a byte limit,
 * and split on whole characters because half a UTF-8 sequence is not text. A
 * description carrying a name in a non-Latin script is the ordinary case here,
 * not an exotic one.
 */
function fold(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    // The continuation's leading space costs an octet of the next line's budget.
    const budget = out.length === 0 ? MAX_OCTETS : MAX_OCTETS - 1;
    if (octets + size > budget) {
      out.push(current);
      current = '';
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.map((part, index) => (index === 0 ? part : ` ${part}`));
}

/** The .ics body for one recipient. */
export function buildCalendarInvite(invite: CalendarInvite): string {
  const cancelled = invite.method === 'CANCEL';
  const end = new Date(invite.startsAt.getTime() + invite.durationMinutes * 60_000);
  const properties: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Questor//Interview scheduling//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${invite.method}`,
    'BEGIN:VEVENT',
    `UID:${escapeText(invite.uid)}`,
    `DTSTAMP:${utcStamp(invite.stamp ?? new Date())}`,
    `DTSTART:${utcStamp(invite.startsAt)}`,
    `DTEND:${utcStamp(end)}`,
    `SEQUENCE:${invite.sequence}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `SUMMARY:${escapeText(invite.summary)}`,
    `DESCRIPTION:${escapeText(invite.description)}`,
    ...(invite.location ? [`LOCATION:${escapeText(invite.location)}`] : []),
    `ORGANIZER;CN=${escapeText(invite.organizerName)}:mailto:${invite.organizerEmail}`,
    // RSVP is not asked for. Questor does not read replies, and a client that
    // shows Accept/Decline buttons nothing listens to is a lie about the product.
    `ATTENDEE;CN=${escapeText(invite.recipientName)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${invite.recipientEmail}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return properties.flatMap(fold).join('\r\n');
}

/**
 * The invitation as an email attachment.
 *
 * Built together with the body on purpose: a MIME `method=` that disagrees with
 * the METHOD inside is shown by most clients as a plain file attachment rather
 * than an invitation, and the two drifting apart is the easiest mistake to make
 * here. They cannot drift if only one function produces both.
 */
export function calendarAttachment(invite: CalendarInvite): EmailAttachment {
  return {
    filename: 'invite.ics',
    content: buildCalendarInvite(invite),
    contentType: `text/calendar; charset=utf-8; method=${invite.method}`,
  };
}
