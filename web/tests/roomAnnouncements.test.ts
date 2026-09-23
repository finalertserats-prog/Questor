import { describe, it, expect } from 'vitest';
import {
  ANNOUNCEMENT_KINDS, EMPTY_ANNOUNCER, SILENT_SAMPLES, announcementFor, assertiveText, countSilence,
  micSeemsDead, politeText, say, timeLeftStage, type RoomEvent,
} from '../src/components/room/roomAnnouncements';

/**
 * The rule this model exists to enforce: the room announces only what makes no
 * sound. A blind candidate hears the interviewer, so nothing audible is ever
 * repeated to them in text.
 */

describe('what the room is allowed to announce', () => {
  it('has a fixed list of announceable events', () => {
    expect([...ANNOUNCEMENT_KINDS]).toEqual([
      'joined', 'heard', 'mic-unavailable', 'mic-silent', 'offline', 'online',
      'observer-joined', 'observer-left', 'time-left', 'ended', 'unspoken-turn',
    ]);
  });

  it('has no event for the interviewer speaking', () => {
    const audible = ANNOUNCEMENT_KINDS.filter((kind) => /speak|speaking|caption|voice|said/i.test(kind));
    expect(audible).toEqual([]);
  });
});

describe('the words themselves', () => {
  it('confirms a finished answer was heard', () => {
    expect(announcementFor({ kind: 'heard', turn: 't1' }).message).toBe('Got it — sending your answer.');
  });

  it('says a microphone we could not open needs attention now', () => {
    expect(announcementFor({ kind: 'mic-unavailable' }).assertive).toBe(true);
  });

  it('says a microphone picking up nothing needs attention now', () => {
    expect(announcementFor({ kind: 'mic-silent', turn: 't1' }).assertive).toBe(true);
  });

  it('interrupts for a dropped connection, because it changes what to do', () => {
    expect(announcementFor({ kind: 'offline' }).assertive).toBe(true);
  });

  it('waits its turn to say the connection is back', () => {
    expect(announcementFor({ kind: 'online' }).assertive).toBe(false);
  });

  it('names an observer who joined, because their arrival is silent', () => {
    expect(announcementFor({ kind: 'observer-joined', name: 'Priya Rao' }).message)
      .toContain('Priya Rao');
  });

  it('says an observer left', () => {
    expect(announcementFor({ kind: 'observer-left', name: 'Priya Rao' }).message)
      .toContain('has left');
  });

  it('says what happens now when the interview ends', () => {
    expect(announcementFor({ kind: 'ended', withdrawn: false }).message)
      .toContain('microphone is off');
  });

  it('gives the interviewer words only when nothing was heard', () => {
    const event: RoomEvent = { kind: 'unspoken-turn', id: 'm3', interviewer: 'Maya', text: 'Tell me about Kafka.' };
    expect(announcementFor(event).message).toBe('Maya: Tell me about Kafka.');
  });

  it('never interrupts with the interviewer words', () => {
    expect(announcementFor({ kind: 'unspoken-turn', id: 'm3', interviewer: 'Maya', text: 'Hi.' }).assertive).toBe(false);
  });
});

describe('not saying the same thing twice', () => {
  const heard = (turn: string): RoomEvent => ({ kind: 'heard', turn });

  it('says nothing when there is no event', () => {
    expect(politeText(say(EMPTY_ANNOUNCER, null))).toBe('');
  });

  it('says it once', () => {
    expect(politeText(say(EMPTY_ANNOUNCER, heard('t1')))).toBe('Got it — sending your answer.');
  });

  it('ignores the same event repeated', () => {
    const once = say(EMPTY_ANNOUNCER, heard('t1'));
    expect(say(once, heard('t1'))).toBe(once);
  });

  it('says it again for a later answer, in the other slot so it is read again', () => {
    const first = say(EMPTY_ANNOUNCER, heard('t1'));
    const second = say(first, heard('t2'));
    expect(politeText(second)).toBe('Got it — sending your answer.');
    expect(second.polite).not.toEqual(first.polite);
  });

  it('keeps the urgent channel clear while it is being polite', () => {
    expect(assertiveText(say(EMPTY_ANNOUNCER, heard('t1')))).toBe('');
  });

  it('does not let a polite message wipe an urgent one off the page', () => {
    const urgent = say(EMPTY_ANNOUNCER, { kind: 'offline' });
    const then = say(urgent, heard('t1'));
    expect(assertiveText(then)).toContain('offline');
  });

  it('says the urgent thing again after something polite came between', () => {
    const urgent = say(EMPTY_ANNOUNCER, { kind: 'offline' });
    const between = say(urgent, heard('t1'));
    const again = say(between, { kind: 'offline' });
    // A different slot, so the identical words are a real change and are read.
    expect(again.assertive).not.toEqual(urgent.assertive);
  });

  it('says it again when the connection drops a second time', () => {
    const down = say(EMPTY_ANNOUNCER, { kind: 'offline' });
    const up = say(down, { kind: 'online' });
    expect(assertiveText(say(up, { kind: 'offline' }))).toContain('offline');
  });
});

describe('noticing a microphone that hears nothing', () => {
  it('counts a silent sample', () => {
    expect(countSilence(0, { level: 0, heardWords: false })).toBe(1);
  });

  it('starts over the moment there is sound', () => {
    expect(countSilence(5, { level: 0.4, heardWords: false })).toBe(0);
  });

  it('starts over when words came through, however quiet', () => {
    expect(countSilence(5, { level: 0, heardWords: true })).toBe(0);
  });

  it('speaks up once the silence has gone on long enough', () => {
    expect(micSeemsDead(SILENT_SAMPLES)).toBe(true);
  });

  it('stays quiet before then', () => {
    expect(micSeemsDead(SILENT_SAMPLES - 1)).toBe(false);
  });

  it('does not repeat itself as the silence goes on', () => {
    expect(micSeemsDead(SILENT_SAMPLES + 1)).toBe(false);
  });
});

describe('the time a sighted candidate can read off the bar', () => {
  const minutes = (n: number) => n * 60_000;

  it('says nothing early on', () => {
    expect(timeLeftStage(30, minutes(2))).toBeNull();
  });

  it('says nothing before the clock has started', () => {
    expect(timeLeftStage(30, 0)).toBeNull();
  });

  it('warns at five minutes left', () => {
    expect(timeLeftStage(30, minutes(25.5))).toBe('five');
  });

  it('warns again in the last minute', () => {
    expect(timeLeftStage(30, minutes(29.5))).toBe('last');
  });

  it('says so once the planned time has passed', () => {
    expect(timeLeftStage(30, minutes(31))).toBe('over');
  });
});
