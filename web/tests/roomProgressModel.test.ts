import { describe, it, expect } from 'vitest';
import {
  formatElapsed, timeLeftText, progressLabel, timeTrack, questionNumber,
} from '../src/components/room/roomProgressModel';

describe('formatElapsed', () => {
  it('shows zero before the interview starts', () => {
    expect(formatElapsed(0)).toBe('00:00');
  });

  it('pads minutes and seconds', () => {
    expect(formatElapsed(4 * 60_000 + 7_000)).toBe('04:07');
  });

  it('keeps counting past an hour in minutes', () => {
    expect(formatElapsed(61 * 60_000)).toBe('61:00');
  });
});

describe('timeLeftText', () => {
  it('rounds the minutes left up so it never under-promises', () => {
    expect(timeLeftText(30, 10 * 60_000 + 20_000)).toBe('about 20 min left');
  });

  it('says less than a minute near the end', () => {
    expect(timeLeftText(30, 29 * 60_000 + 30_000)).toBe('less than a minute left');
  });

  it('does not count below zero once the planned time has passed', () => {
    expect(timeLeftText(30, 35 * 60_000)).toBe('past the planned time');
  });
});

describe('progressLabel', () => {
  it('states the length before the interview starts', () => {
    expect(progressLabel({ started: false, durationMinutes: 30, elapsedMs: 0, question: null })).toBe('30 min interview');
  });

  it('shows only time when the question number is not known', () => {
    expect(progressLabel({ started: true, durationMinutes: 30, elapsedMs: 60_000, question: null })).toBe('about 29 min left');
  });

  it('includes the question number when it is known', () => {
    expect(progressLabel({ started: true, durationMinutes: 30, elapsedMs: 60_000, question: 3 })).toBe('Question 3 · about 29 min left');
  });
});

describe('timeTrack', () => {
  it('has every segment ahead before the start', () => {
    expect(timeTrack(0, 40, 4)).toEqual(['ahead', 'ahead', 'ahead', 'ahead']);
  });

  it('marks passed, current and later segments by elapsed time', () => {
    expect(timeTrack(15 * 60_000, 40, 4)).toEqual(['done', 'now', 'ahead', 'ahead']);
  });

  it('is fully done past the planned time', () => {
    expect(timeTrack(50 * 60_000, 40, 4)).toEqual(['done', 'done', 'done', 'done']);
  });
});

describe('questionNumber', () => {
  it('is unknown while only the opening has been said', () => {
    expect(questionNumber([{ speaker: 'agent' }])).toBeNull();
  });

  it('counts each interviewer turn after the opening as a question', () => {
    const msgs = [
      { speaker: 'agent' as const },
      { speaker: 'candidate' as const },
      { speaker: 'agent' as const },
      { speaker: 'candidate' as const },
      { speaker: 'agent' as const },
    ];
    expect(questionNumber(msgs)).toBe(2);
  });

  it('does not count a check-in after a silence', () => {
    const msgs = [
      { speaker: 'agent' as const },
      { speaker: 'candidate' as const },
      { speaker: 'agent' as const },
      { speaker: 'agent' as const, nudge: true },
    ];
    expect(questionNumber(msgs)).toBe(1);
  });
});
