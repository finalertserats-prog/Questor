import { describe, it, expect } from 'vitest';
import {
  initialTimeZone, isValidTimeZone, listTimeZones, schedulePreview, scheduleRequest, timeZoneOptionLabel, zonedLocalToUtc,
} from '../src/components/zonedScheduleModel';

/**
 * The scheduling picker: zone first, then date, then time, with a preview of
 * what was picked. The browser used to read a datetime-local through its own
 * zone, so a recruiter in London booking for Bengaluru booked London's clock.
 */

const NOW = new Date('2026-09-21T12:00:00.000Z');

describe('converting a wall-clock time in a zone', () => {
  it('reads a Kolkata time as Kolkata', () => {
    const result = zonedLocalToUtc('2026-10-01T14:30', 'Asia/Kolkata');
    expect(result.ok && result.at.toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });

  it('knows a spring-forward time never happens', () => {
    expect(zonedLocalToUtc('2026-03-08T02:30', 'America/New_York')).toEqual({ ok: false, reason: 'gap' });
  });

  it('refuses a two-digit year rather than reading it as the 1900s', () => {
    expect(zonedLocalToUtc('0099-01-01T09:00', 'UTC')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('takes the earlier of an autumn time that happens twice', () => {
    const result = zonedLocalToUtc('2026-10-25T01:30', 'Europe/London');
    expect(result.ok && result.at.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('the zone list', () => {
  it('includes UTC', () => {
    expect(listTimeZones()).toContain('UTC');
  });

  it('includes real IANA zones', () => {
    expect(listTimeZones()).toContain('Asia/Kolkata');
  });

  it('lists a renamed zone once, under its current name', () => {
    expect(listTimeZones()).not.toContain('Asia/Calcutta');
  });

  it('accepts a zone', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
  });

  it('accepts an older spelling of a zone', () => {
    expect(isValidTimeZone('Asia/Calcutta')).toBe(true);
  });

  it('refuses something typed that is not a zone', () => {
    expect(isValidTimeZone('Kolkata')).toBe(false);
  });

  it('starts on the current name when the browser reports an old one', () => {
    expect(initialTimeZone(null, 'Asia/Calcutta')).toBe('Asia/Kolkata');
  });

  it('labels a zone with its current offset', () => {
    expect(timeZoneOptionLabel('Asia/Kolkata', NOW)).toBe('GMT+5:30');
  });
});

describe('the zone the picker starts on', () => {
  it('is the organisation zone when set', () => {
    expect(initialTimeZone('Asia/Kolkata', 'Europe/London')).toBe('Asia/Kolkata');
  });

  it('is the browser zone when the organisation has none', () => {
    expect(initialTimeZone(null, 'Europe/London')).toBe('Europe/London');
  });

  it('is UTC when neither is usable', () => {
    expect(initialTimeZone('Mars/Base', undefined)).toBe('UTC');
  });
});

describe('the preview under the picker', () => {
  const draft = { timeZone: 'Asia/Kolkata', date: '2026-10-01', time: '14:30' };

  it('waits until everything is filled in', () => {
    expect(schedulePreview({ ...draft, time: '' }, NOW, 'Asia/Kolkata').kind).toBe('incomplete');
  });

  it('shows the time in the chosen zone and in UTC', () => {
    const preview = schedulePreview(draft, NOW, 'Asia/Kolkata');
    expect(preview.kind === 'ok' && preview.text).toMatch(/14:30 .*Asia\/Kolkata.*= 09:00 UTC/);
  });

  it('adds the viewer’s own time when their clock differs', () => {
    const preview = schedulePreview(draft, NOW, 'Europe/London');
    expect(preview.kind === 'ok' && preview.text).toContain('10:00 your time');
  });

  it('leaves the viewer’s time out when it is the same clock', () => {
    const preview = schedulePreview(draft, NOW, 'Asia/Kolkata');
    expect(preview.kind === 'ok' && preview.text).not.toContain('your time');
  });

  it('refuses a skipped time and names the zone', () => {
    const preview = schedulePreview({ timeZone: 'America/New_York', date: '2026-03-08', time: '02:30' }, new Date('2026-01-01T00:00:00Z'), 'UTC');
    expect(preview.kind === 'problem' && preview.text).toContain('America/New_York');
  });

  it('refuses a time already gone', () => {
    expect(schedulePreview({ ...draft, date: '2026-09-01' }, NOW, 'UTC').kind).toBe('problem');
  });

  it('refuses a zone that is not in the list', () => {
    expect(schedulePreview({ ...draft, timeZone: 'Kolkata' }, NOW, 'UTC').kind).toBe('problem');
  });
});

describe('what is sent to the server', () => {
  it('is the date, time and zone as picked — never a browser-converted instant', () => {
    expect(scheduleRequest({ timeZone: 'Asia/Kolkata', date: '2026-10-01', time: '14:30' }))
      .toEqual({ date: '2026-10-01', time: '14:30', timeZone: 'Asia/Kolkata' });
  });
});
