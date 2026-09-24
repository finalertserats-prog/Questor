import { describe, it, expect } from 'vitest';
import {
  MIC_DENIED_NOTICE, SPEECH_NOTICE, SPEECH_UNSUPPORTED_NOTICE, afterTheBoxText,
  failureCopy, failureFor, observerAnnouncement, speechRoute, timeLeftText, timerMayBeShown,
} from '../src/components/demoInterviewModel';

const clock = (over: Partial<Parameters<typeof timeLeftText>[0]> = {}) =>
  ({ msLeft: 9 * 60_000, mayExtend: true, closing: false, ended: false, ...over });

describe('the clock, when it is shown at all', () => {
  // A countdown beside the interviewer is the product talking over its own
  // interviewer. It is available on request and nowhere else.
  it('is hidden during the interview unless the viewer asks for it', () => {
    expect(timerMayBeShown(clock(), false)).toBe(false);
    expect(timerMayBeShown(clock(), true)).toBe(true);
  });

  it('is shown once the interview is over, asked for or not', () => {
    expect(timerMayBeShown(clock({ ended: true }), false)).toBe(true);
  });

  // Rounded to the minute: a live-updating second count is read aloud over the
  // interviewer by a screen reader.
  it('never reads out a running second count', () => {
    expect(timeLeftText(clock({ msLeft: 8 * 60_000 + 42_000 }))).toBe('About 9 minutes left.');
    expect(timeLeftText(clock({ msLeft: 30_000 }))).toBe('About a minute left.');
    expect(timeLeftText(clock({ msLeft: 0 }))).toBe('Wrapping up now.');
    expect(timeLeftText(clock({ ended: true }))).toMatch(/finished/);
  });
});

describe('the dictation route', () => {
  it('offers speech only where the browser actually has it', () => {
    expect(speechRoute({ supported: true, micDenied: false })).toBe('offer');
    expect(speechRoute({ supported: false, micDenied: false })).toBe('unsupported');
    expect(speechRoute({ supported: true, micDenied: true })).toBe('denied');
  });

  // The two things that are true and not obvious.
  it('says who does the listening and where the audio goes', () => {
    expect(SPEECH_NOTICE).toMatch(/your browser/i);
    expect(SPEECH_NOTICE).toMatch(/google/i);
  });

  it('always points at typing as the route that needs nothing', () => {
    for (const notice of [SPEECH_NOTICE, SPEECH_UNSUPPORTED_NOTICE, MIC_DENIED_NOTICE]) {
      expect(notice).toMatch(/typing|the box below/i);
    }
  });

  it('does not blame the visitor for a browser that cannot do it', () => {
    expect(SPEECH_UNSUPPORTED_NOTICE).not.toMatch(/sorry|error|unsupported browser/i);
  });
});

describe('what the visitor is told when something fails', () => {
  it('does not call a deliberate deletion a fault', () => {
    const copy = failureCopy('sandbox_gone');
    expect(copy.message).toMatch(/deleted after seven days/i);
    expect(copy.message).not.toMatch(/went wrong|error|sorry/i);
  });

  it('takes the blame for the interviewer failing, rather than leaving it ambiguous', () => {
    expect(failureCopy('engine_unavailable').message).toMatch(/none of this is anything you did/i);
  });

  it('offers something a visitor can actually do, for every failure it knows', () => {
    for (const kind of ['sandbox_gone', 'engine_unavailable', 'already_taken', 'network', 'unknown'] as const) {
      expect(failureCopy(kind).action).toBeTruthy();
      expect(failureCopy(kind).title.length).toBeGreaterThan(0);
    }
  });

  it('reads a dropped connection as a dropped connection, not as a fault', () => {
    expect(failureFor(undefined, undefined)).toBe('network');
    expect(failureCopy('network').message).toMatch(/kept on our side/i);
  });

  it('maps the server\'s own codes onto the pages that explain them', () => {
    expect(failureFor(409, 'sandbox_gone')).toBe('sandbox_gone');
    expect(failureFor(409, 'already_taken')).toBe('already_taken');
    expect(failureFor(409, 'already_open')).toBe('already_open');
    expect(failureFor(409, 'already_starting')).toBe('already_open');
  });

  // This read any 409 as "the sandbox has been cleared", so a visitor who
  // simply had an interview open was told their data had been deleted.
  it('never reads an unrecognised refusal as a deletion', () => {
    expect(failureFor(409, undefined)).toBe('unknown');
    expect(failureFor(409, 'something_new')).toBe('unknown');
  });
});

describe('what the room says once the box has closed it', () => {
  it('never presents the close as a failure, in either mode', () => {
    for (const mode of ['candidate', 'observer'] as const) {
      expect(afterTheBoxText(mode)).not.toMatch(/error|sorry|limit|quota|unavailable/i);
    }
  });

  it('points at the page a real candidate would see next', () => {
    expect(afterTheBoxText('candidate')).toMatch(/real candidate sees/i);
  });
});

describe('what a screen reader is told in observer mode', () => {
  // The room's rule is "announce only what makes no sound". In observer mode
  // nothing makes a sound, so every turn is the event.
  it('names the speaker and reads the turn', () => {
    expect(observerAnnouncement({ speaker: 'agent', text: 'Tell me about a pipeline.' }, 'Maya', 'Ravi'))
      .toBe('Maya said: Tell me about a pipeline.');
    expect(observerAnnouncement({ speaker: 'candidate', text: 'I owned ninety DAGs.' }, 'Maya', 'Ravi'))
      .toBe('Ravi said: I owned ninety DAGs.');
  });

  it('says nothing when there is no new turn', () => {
    expect(observerAnnouncement(undefined, 'Maya', 'Ravi')).toBe('');
  });
});
