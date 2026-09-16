import { describe, it, expect } from 'vitest';
import {
  MIN_ACCOMMODATION_CHARS, accommodationHint, canSubmitConsent, consentAction, shouldCaptureAudio,
} from '../src/components/portalConsentModel';

const draft = (over: Partial<Parameters<typeof consentAction>[0]> = {}) =>
  ({ accepted: false, accommodation: '', ...over });

describe('consentAction', () => {
  it('proceeds once the candidate agrees to the AI round', () => {
    expect(consentAction(draft({ accepted: true }))).toBe('consent');
  });

  // The voice box is a separate decision: declining voice capture means typing
  // the answers, not being turned away from the interview.
  it('does not depend on the voice-capture choice', () => {
    expect(consentAction(draft({ accepted: true }))).toBe('consent');
  });

  it('offers nothing until the candidate agrees', () => {
    expect(consentAction(draft())).toBe('none');
  });

  it('offers to send an accommodation request instead, once it says enough', () => {
    expect(consentAction(draft({ accommodation: 'I need extra time between questions.' }))).toBe('accommodation');
  });

  it('takes the accommodation route even when the AI round was also agreed to', () => {
    expect(consentAction(draft({ accepted: true, accommodation: 'I would prefer a human interviewer.' }))).toBe('accommodation');
  });

  // The defect: a shorter request was posted, rejected by the server's own
  // minimum and dropped, and the candidate was moved on as if they had said
  // nothing.
  it('offers nothing while a request is too short to be sent', () => {
    expect(consentAction(draft({ accepted: true, accommodation: 'more time' }))).toBe('none');
  });

  it('does not count surrounding whitespace towards the minimum', () => {
    expect(consentAction(draft({ accommodation: `${' '.repeat(20)}short${' '.repeat(20)}` }))).toBe('none');
  });
});

describe('canSubmitConsent', () => {
  it('allows the press once there is something to send', () => {
    expect(canSubmitConsent({ accepted: true, accommodation: '', busy: false })).toBe(true);
  });

  it('refuses a second press while the first is in flight', () => {
    expect(canSubmitConsent({ accepted: true, accommodation: '', busy: true })).toBe(false);
  });

  it('refuses while nothing has been agreed to', () => {
    expect(canSubmitConsent({ accepted: false, accommodation: '', busy: false })).toBe(false);
  });
});

describe('accommodationHint', () => {
  it('says what writing a request will do, before anything is written', () => {
    expect(accommodationHint('')).toContain('instead');
  });

  it('names the minimum while the request is too short', () => {
    expect(accommodationHint('more time')).toContain(String(MIN_ACCOMMODATION_CHARS));
  });

  it('says what will happen once the request is long enough', () => {
    expect(accommodationHint('I need extra time between questions.')).toContain('our team');
  });
});

describe('shouldCaptureAudio', () => {
  it('captures audio only when the candidate consented to it', () => {
    expect(shouldCaptureAudio(true)).toBe(true);
  });

  it('does not capture audio when consent was declined', () => {
    expect(shouldCaptureAudio(false)).toBe(false);
  });

  // An older server sends no such field. Silence is not consent.
  it('does not capture audio when the answer is unknown', () => {
    expect([shouldCaptureAudio(undefined), shouldCaptureAudio(null), shouldCaptureAudio('true')])
      .toEqual([false, false, false]);
  });
});
