// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RoomAnnouncer } from '../src/components/room/RoomAnnouncer';
import { EMPTY_ANNOUNCER, say } from '../src/components/room/roomAnnouncements';

const ROOM = join(import.meta.dirname, '..', 'src', 'components', 'room');
const SRC = join(import.meta.dirname, '..', 'src');

afterEach(cleanup);

describe('the room announcer', () => {
  it('says nothing at all before anything has happened', () => {
    render(createElement(RoomAnnouncer, { state: EMPTY_ANNOUNCER }));
    expect(screen.getByTestId('room-announcer').textContent).toBe('');
  });

  it('puts an ordinary message in a polite region', () => {
    render(createElement(RoomAnnouncer, { state: say(EMPTY_ANNOUNCER, { kind: 'heard', turn: 't1' }) }));
    const polite = screen.getAllByRole('status').map((n) => n.textContent).join('');
    expect(polite).toBe('Got it — sending your answer.');
  });

  it('leaves the interrupting region empty for an ordinary message', () => {
    render(createElement(RoomAnnouncer, { state: say(EMPTY_ANNOUNCER, { kind: 'heard', turn: 't1' }) }));
    expect(screen.queryAllByRole('alert').map((n) => n.textContent).join('')).toBe('');
  });

  it('interrupts for a microphone that is hearing nothing', () => {
    render(createElement(RoomAnnouncer, { state: say(EMPTY_ANNOUNCER, { kind: 'mic-silent', turn: 't1' }) }));
    expect(screen.getAllByRole('alert').map((n) => n.textContent).join('')).toContain('not picking up any sound');
  });

  it('marks every region atomic, so a half-written sentence is never read', () => {
    render(createElement(RoomAnnouncer, { state: EMPTY_ANNOUNCER }));
    const regions = [...screen.getByTestId('room-announcer').querySelectorAll('[aria-live]')];
    expect(regions.every((n) => n.getAttribute('aria-atomic') === 'true')).toBe(true);
  });

  it('is never on screen', () => {
    render(createElement(RoomAnnouncer, { state: EMPTY_ANNOUNCER }));
    expect(screen.getByTestId('room-announcer').className).toContain('visually-hidden');
  });
});

/**
 * The guard the owner asked for.
 *
 * "Why do you need 'Maya is speaking', it feels so artificial" — and they are
 * right: a blind candidate HEARS Maya. The room must never announce anything
 * audible. Two things stand in the way of that creeping back:
 *
 *   1. `RoomEvent` has no case for the interviewer speaking, so no announcement
 *      of one can be built (roomAnnouncements.test.ts).
 *   2. The inventory below. Every live region in the room is listed here with
 *      what it is for. Adding one — an aria-live on the transcript, a role of
 *      status on the interviewer tile — fails this test until someone writes
 *      down why it is not something the candidate can already hear.
 */
const LIVE_REGIONS: Readonly<Record<string, number>> = {
  // Two polite slots and two interrupting ones; the model decides what goes in.
  'RoomAnnouncer.tsx': 4,
  // The paused banner, and the read-back of the candidate's OWN words, which
  // the candidate asks for and can switch off. Neither is the interviewer.
  'Composer.tsx': 2,
  // The room's error line. An error changes what the candidate should do.
  'Conversation.tsx': 1,
  // "Connecting to the interview room…", before the room exists.
  'RoomPanels.tsx': 1,
};

/** One count per element that announces: a role and an aria-live on one element are one region. */
function liveRegionCount(source: string): number {
  return source.split('\n').filter((line) => /\baria-live=|\brole="(?:status|alert)"/.test(line)).length;
}

describe('nothing audible is ever announced', () => {
  it('has a live region only where this test says it may', () => {
    const found: Record<string, number> = {};
    for (const name of readdirSync(ROOM).filter((f) => f.endsWith('.tsx'))) {
      const count = liveRegionCount(readFileSync(join(ROOM, name), 'utf8'));
      if (count > 0) found[name] = count;
    }
    expect(found).toEqual(LIVE_REGIONS);
  });

  it('keeps the room orchestrator itself free of live regions', () => {
    const source = readFileSync(join(SRC, 'pages', 'InterviewRoom.tsx'), 'utf8');
    expect(liveRegionCount(source)).toBe(0);
  });

  it('never announces the interviewer turn as it is added to the transcript', () => {
    const source = readFileSync(join(ROOM, 'Conversation.tsx'), 'utf8');
    // The transcript is read on request, never read out. An announcement built
    // from the interviewer name and a message text is exactly what was removed.
    expect(/interviewer\.name\}: \$\{/.test(source)).toBe(false);
    expect(/setAnnouncement/.test(source)).toBe(false);
  });

  it('never announces which participant is speaking', () => {
    const files = readdirSync(ROOM).filter((f) => f.endsWith('.tsx')).map((f) => join(ROOM, f));
    const offenders = files.filter((file) => /aiStatus|aiSpeaking/.test(readFileSync(file, 'utf8'))
      && liveRegionCount(readFileSync(file, 'utf8')) > 0);
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
