import { describe, it, expect } from 'vitest';
import { buildCalendarInvite, calendarAttachment, roundCalendarUid, sessionCalendarUid } from '../src/services/calendarInvite.js';

/**
 * The calendar attachment.
 *
 * An email cannot know what zone its reader is in; a calendar entry does not
 * need to, because the reader's own app renders the instant. That only holds if
 * the attachment is right, though — and a half-right one is worse than none,
 * because a duplicate entry or a silently-ignored update is harder to notice
 * than a missing attachment.
 *
 * The four rules being held to here are the ones that break quietly:
 * a stable UID (a fresh one produces a second entry instead of an update),
 * a rising SEQUENCE (Outlook drops an update whose sequence did not move),
 * a MIME method matching the body's METHOD (clients that disagree show a file
 * attachment instead of an invitation), and UTC stamps (so there is no
 * VTIMEZONE to get wrong).
 */

const BASE = {
  uid: 'round-abc@questor.local',
  sequence: 0,
  method: 'REQUEST' as const,
  startsAt: new Date('2026-10-01T09:00:00.000Z'),
  durationMinutes: 45,
  summary: 'Questor interview — Gold round',
  description: 'Open the round in Questor: https://questor.test/candidates/c1',
  location: 'https://meet.example.com/abc',
  organizerName: 'Acme hiring team',
  organizerEmail: 'no-reply@questor.local',
  recipientName: 'Ada Lovelace',
  recipientEmail: 'ada@example.com',
  stamp: new Date('2026-09-25T08:00:00.000Z'),
};

function lines(ics: string): string[] {
  // Unfold first: a long property is split across continuation lines that begin
  // with a space, and a test that reads raw lines would miss half of it.
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n');
}

function prop(ics: string, name: string): string | undefined {
  return lines(ics).find((l) => l === name || l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

describe('an interview calendar invitation', () => {
  it('is a calendar object a client will parse', () => {
    const ics = buildCalendarInvite(BASE);

    expect(lines(ics).slice(0, 2)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0']);
  });

  it('ends the calendar object it opened', () => {
    expect(lines(buildCalendarInvite(BASE)).at(-1)).toBe('END:VCALENDAR');
  });

  it('separates lines with CRLF, as the format requires', () => {
    expect(buildCalendarInvite(BASE)).toContain('\r\n');
  });

  it('states the instant in UTC, so there is no VTIMEZONE to get wrong', () => {
    const ics = buildCalendarInvite(BASE);

    expect(prop(ics, 'DTSTART')).toBe('DTSTART:20261001T090000Z');
  });

  it('carries no VTIMEZONE at all', () => {
    expect(buildCalendarInvite(BASE)).not.toContain('VTIMEZONE');
  });

  it('ends the event after the booked duration', () => {
    expect(prop(buildCalendarInvite(BASE), 'DTEND')).toBe('DTEND:20261001T094500Z');
  });

  it('keeps one UID for a round, so a reschedule updates the entry', () => {
    const booked = buildCalendarInvite(BASE);
    const moved = buildCalendarInvite({ ...BASE, sequence: 1, startsAt: new Date('2026-10-02T09:00:00.000Z') });

    expect(prop(moved, 'UID')).toBe(prop(booked, 'UID'));
  });

  it('raises the sequence on a change, because Outlook ignores an update that does not', () => {
    expect(prop(buildCalendarInvite({ ...BASE, sequence: 3 }), 'SEQUENCE')).toBe('SEQUENCE:3');
  });

  it('asks for a booking with METHOD:REQUEST', () => {
    expect(prop(buildCalendarInvite(BASE), 'METHOD')).toBe('METHOD:REQUEST');
  });

  it('confirms a booking rather than leaving its status open', () => {
    expect(prop(buildCalendarInvite(BASE), 'STATUS')).toBe('STATUS:CONFIRMED');
  });

  it('cancels with both the method and the status, which clients read separately', () => {
    const ics = buildCalendarInvite({ ...BASE, method: 'CANCEL', sequence: 2 });

    expect([prop(ics, 'METHOD'), prop(ics, 'STATUS')]).toEqual(['METHOD:CANCEL', 'STATUS:CANCELLED']);
  });

  it('names exactly one attendee — the person this copy is for', () => {
    const attendees = lines(buildCalendarInvite(BASE)).filter((l) => l.startsWith('ATTENDEE'));

    expect(attendees).toHaveLength(1);
  });

  it('puts that attendee’s own address on their own copy', () => {
    expect(prop(buildCalendarInvite(BASE), 'ATTENDEE')).toContain('mailto:ada@example.com');
  });

  it('escapes a comma in the summary rather than starting a second value', () => {
    const ics = buildCalendarInvite({ ...BASE, summary: 'Interview, round two' });

    expect(prop(ics, 'SUMMARY')).toBe('SUMMARY:Interview\\, round two');
  });

  it('escapes a newline in the description instead of ending the property', () => {
    const ics = buildCalendarInvite({ ...BASE, description: 'One\nTwo' });

    expect(prop(ics, 'DESCRIPTION')).toBe('DESCRIPTION:One\\nTwo');
  });

  it('folds a line longer than the format allows', () => {
    const ics = buildCalendarInvite({ ...BASE, description: 'x'.repeat(400) });

    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75)).toBe(true);
  });

  it('leaves out a location there is no link for', () => {
    expect(prop(buildCalendarInvite({ ...BASE, location: null }), 'LOCATION')).toBeUndefined();
  });
});

describe('the attachment the invitation travels as', () => {
  it('declares the same method in the MIME type as the body states', () => {
    const attachment = calendarAttachment(BASE);

    expect(attachment.contentType).toBe('text/calendar; charset=utf-8; method=REQUEST');
  });

  it('declares CANCEL in the MIME type for a cancellation', () => {
    expect(calendarAttachment({ ...BASE, method: 'CANCEL' }).contentType).toBe('text/calendar; charset=utf-8; method=CANCEL');
  });

  it('is named so a mail client offers to add it', () => {
    expect(calendarAttachment(BASE).filename).toBe('invite.ics');
  });

  it('carries the calendar object as its content', () => {
    expect(calendarAttachment(BASE).content).toContain('BEGIN:VEVENT');
  });
});

describe('the identity of an interview in a calendar', () => {
  it('is stable for a round', () => {
    expect(roundCalendarUid('abc')).toBe(roundCalendarUid('abc'));
  });

  it('differs between two rounds', () => {
    expect(roundCalendarUid('abc')).not.toBe(roundCalendarUid('def'));
  });

  it('never collides with an AI interview’s', () => {
    expect(roundCalendarUid('abc')).not.toBe(sessionCalendarUid('abc'));
  });

  it('is a global identifier, so it carries a domain', () => {
    expect(roundCalendarUid('abc')).toMatch(/@/);
  });
});
