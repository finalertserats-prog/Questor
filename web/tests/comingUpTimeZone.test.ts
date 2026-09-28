import { describe, it, expect } from 'vitest';
import { comingUpWhen, crewNote, itemZone, zoneOffsetLabel, type ComingUpItem, type CrewMember } from '../src/components/hrbox/needsYouModel';

/**
 * Home used to write every "Coming up" row on the organisation's clock, with a
 * raw Intl call and no zone named — while the server was already sending each
 * row the zone its interview was actually booked in, and the page threw it
 * away. An admin in Bengaluru reading a New York round saw a Bengaluru time
 * with nothing to say it was one.
 *
 * The rule these hold to: every interview instant names the clock it is on.
 */

const ITEM: ComingUpItem = {
  id: 'r1', kind: 'human', at: '2026-09-22T11:00:00.000Z', timeZone: null, live: false,
  candidate: { id: 'c1', name: 'Arjun Mehta' }, role: { id: 'r1', title: 'Backend Engineer' },
  interviewerId: null, interviewerName: null, to: '/candidates/c1',
};

const member = (over: Partial<CrewMember> = {}): CrewMember => ({
  id: 'avery', name: 'Avery', status: 'scheduled', at: '2026-09-22T11:00:00.000Z', candidateFirstName: null, ...over,
} as CrewMember);

describe('the clock a coming-up row is on', () => {
  it('is the zone the interview was booked in', () => {
    expect(itemZone({ ...ITEM, timeZone: 'America/New_York' }, 'Asia/Kolkata')).toBe('America/New_York');
  });

  it('falls back to the organisation zone when the booking recorded none', () => {
    expect(itemZone(ITEM, 'Asia/Kolkata')).toBe('Asia/Kolkata');
  });

  it('ignores a zone this browser cannot use rather than failing the page', () => {
    expect(itemZone({ ...ITEM, timeZone: 'Mars/Olympus_Mons' }, 'Asia/Kolkata')).toBe('Asia/Kolkata');
  });
});

describe('naming the clock', () => {
  it('gives an offset, never a bare city name', () => {
    expect(zoneOffsetLabel(Date.parse(ITEM.at), 'Asia/Kolkata')).toMatch(/^(GMT|UTC|[A-Z]{2,5})/);
  });

  it('tells two zones apart', () => {
    const kolkata = zoneOffsetLabel(Date.parse(ITEM.at), 'Asia/Kolkata');
    expect(zoneOffsetLabel(Date.parse(ITEM.at), 'America/New_York')).not.toBe(kolkata);
  });
});

describe('a coming-up row’s time', () => {
  it('is written on the row’s own clock, not the organisation’s', () => {
    // 11:00 UTC is 07:00 in New York and 16:30 in Kolkata.
    expect(comingUpWhen({ ...ITEM, timeZone: 'America/New_York' }, 'Asia/Kolkata', false)).toContain('07:00');
  });

  it('always names the zone it is on', () => {
    expect(comingUpWhen(ITEM, 'Asia/Kolkata', false)).not.toBe('16:30');
  });

  it('names the booking zone outright when it is not the organisation’s', () => {
    expect(comingUpWhen({ ...ITEM, timeZone: 'America/New_York' }, 'Asia/Kolkata', false)).toContain('America/New_York');
  });

  it('does not repeat the organisation’s own zone name on every row', () => {
    expect(comingUpWhen(ITEM, 'Asia/Kolkata', false)).not.toContain('Asia/Kolkata');
  });

  it('carries the day as well for a row later in the week', () => {
    expect(comingUpWhen(ITEM, 'Asia/Kolkata', true)).toMatch(/Tue 22 Sep/);
  });
});

describe('what the interviewer strip says', () => {
  it('names the zone of the time it shows', () => {
    expect(crewNote(member(), 'Asia/Kolkata')).not.toBe('16:30');
  });

  it('still shows the hour', () => {
    expect(crewNote(member(), 'Asia/Kolkata')).toContain('16:30');
  });

  it('says nothing about a zone when there is no time to show', () => {
    expect(crewNote(member({ status: 'free', at: null }), 'Asia/Kolkata')).toBe('free');
  });
});
