import { describe, it, expect } from 'vitest';
import {
  isCodingQuestion, composerMode, speakAvailability, modeForNewQuestion, insertIndent,
  composerHint, joinAnswer, CODE_NUDGE, MIC_UNAVAILABLE_NOTE, LEAVE_REQUEST_TEXT,
} from '../src/components/room/roomComposerModel';
import { detectWithdrawal } from '../../server/src/engines/policyEngine';

describe('isCodingQuestion', () => {
  it('recognises a request to write a SQL query', () => {
    expect(isCodingQuestion("Let's try some SQL. Given a table events(user_id, event_date), write a query that returns each user's longest run.")).toBe(true);
  });

  it('recognises a request to implement a function', () => {
    expect(isCodingQuestion('Could you implement a function that deduplicates this list?')).toBe(true);
  });

  it('recognises a request to sketch code', () => {
    expect(isCodingQuestion('How would you build a rate limiter? Sketch the code for it.')).toBe(true);
  });

  it('ignores a question that only mentions SQL', () => {
    expect(isCodingQuestion('Tell me about your experience with SQL.')).toBe(false);
  });

  it('ignores a question about how a query behaves', () => {
    expect(isCodingQuestion('How would that query behave on a billion rows?')).toBe(false);
  });

  it('ignores code review as a topic', () => {
    expect(isCodingQuestion('Walk me through how your team runs code review.')).toBe(false);
  });
});

describe('composerMode', () => {
  it('is speak when not typing', () => {
    expect(composerMode(false, true)).toBe('speak');
  });

  it('is code when typing in the code editor', () => {
    expect(composerMode(true, true)).toBe('code');
  });

  it('is type when typing plain text', () => {
    expect(composerMode(true, false)).toBe('type');
  });
});

describe('speakAvailability', () => {
  it('is available with consent and browser support', () => {
    expect(speakAvailability({ consented: true, sttSupported: true })).toBeNull();
  });

  it('explains that voice capture was not agreed', () => {
    expect(speakAvailability({ consented: false, sttSupported: true })).toBe(MIC_UNAVAILABLE_NOTE);
  });

  it('explains a browser that cannot listen', () => {
    expect(speakAvailability({ consented: true, sttSupported: false })).toMatch(/browser/);
  });
});

describe('modeForNewQuestion', () => {
  it('switches to the code editor for a coding question and says so', () => {
    expect(modeForNewQuestion({ mode: 'speak', autoFrom: null, coding: true, canSpeak: true }))
      .toEqual({ mode: 'code', autoFrom: 'speak', nudge: CODE_NUDGE });
  });

  it('returns to the earlier mode after an automatic switch', () => {
    expect(modeForNewQuestion({ mode: 'code', autoFrom: 'speak', coding: false, canSpeak: true }))
      .toEqual({ mode: 'speak', autoFrom: null, nudge: null });
  });

  it('returns to typing when speaking is no longer available', () => {
    expect(modeForNewQuestion({ mode: 'code', autoFrom: 'speak', coding: false, canSpeak: false }).mode).toBe('type');
  });

  it('keeps a code editor the candidate chose themselves', () => {
    expect(modeForNewQuestion({ mode: 'code', autoFrom: null, coding: false, canSpeak: true }).mode).toBe('code');
  });

  it('leaves the mode alone for an ordinary question', () => {
    expect(modeForNewQuestion({ mode: 'type', autoFrom: null, coding: false, canSpeak: true }))
      .toEqual({ mode: 'type', autoFrom: null, nudge: null });
  });
});

describe('insertIndent', () => {
  it('inserts two spaces at the caret', () => {
    expect(insertIndent('ab', 1, 1)).toEqual({ value: 'a  b', caret: 3 });
  });

  it('replaces a selection', () => {
    expect(insertIndent('abcd', 1, 3)).toEqual({ value: 'a  d', caret: 3 });
  });
});

describe('composerHint', () => {
  it('tells a code editor user how to leave with the keyboard', () => {
    expect(composerHint('code')).toMatch(/Esc/);
  });
});

describe('joinAnswer', () => {
  it('joins held and newly heard speech with single spaces', () => {
    expect(joinAnswer(' I lead', '', 'a data  team ')).toBe('I lead a data team');
  });

  it('is empty when nothing was heard', () => {
    expect(joinAnswer('', '  ')).toBe('');
  });
});

describe('LEAVE_REQUEST_TEXT', () => {
  it('is recognised by the server as a request to stop', () => {
    expect(detectWithdrawal(LEAVE_REQUEST_TEXT)).toBe(true);
  });
});
