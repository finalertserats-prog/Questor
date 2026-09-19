import { describe, it, expect } from 'vitest';
import {
  smoothLevel, wordEnvelope, splitWords, wordsSpokenAtChar, estimatedWordsSpoken,
  wordsSpokenAtFraction, rmsLevel, voiceTarget, spokenWords, withAlpha, isSpeakingNow, type VoiceState,
} from '../src/components/room/roomLevelModel';

describe('withAlpha', () => {
  it('turns a computed rgb colour into a translucent one', () => {
    expect(withAlpha('rgb(165, 160, 245)', 0.3)).toBe('rgba(165, 160, 245, 0.3)');
  });

  it('turns a hex colour into a translucent one', () => {
    expect(withAlpha('#f2b880', 0)).toBe('rgba(242, 184, 128, 0)');
  });

  it('falls back to the room accent for a colour it cannot read', () => {
    expect(withAlpha('papayawhip', 1)).toBe('rgba(165, 160, 245, 1)');
  });
});

describe('isSpeakingNow', () => {
  it('turns on above the loud threshold', () => {
    expect(isSpeakingNow(false, 0.2)).toBe(true);
  });

  it('stays on between the thresholds so a short dip does not flicker', () => {
    expect(isSpeakingNow(true, 0.08)).toBe(true);
  });

  it('turns off below the quiet threshold', () => {
    expect(isSpeakingNow(true, 0.02)).toBe(false);
  });
});

describe('smoothLevel', () => {
  it('rises quickly toward a louder target', () => {
    expect(smoothLevel(0, 1)).toBeCloseTo(0.35);
  });

  it('falls slowly toward a quieter target', () => {
    expect(smoothLevel(1, 0)).toBeCloseTo(0.88);
  });

  it('clamps a target above 1', () => {
    expect(smoothLevel(1, 4)).toBe(1);
  });

  it('snaps a vanishing level to zero so the ring stops drawing', () => {
    expect(smoothLevel(0.0005, 0)).toBe(0);
  });
});

describe('wordEnvelope', () => {
  it('dips on a word that ends a phrase', () => {
    expect(wordEnvelope('today.')).toBe(0.25);
  });

  it('is louder for a long word than a short one', () => {
    expect(wordEnvelope('responsibilities')).toBeGreaterThan(wordEnvelope('a'));
  });

  it('never exceeds 1', () => {
    expect(wordEnvelope('supercalifragilisticexpialidocious')).toBe(1);
  });
});

describe('splitWords', () => {
  it('ignores runs of whitespace', () => {
    expect(splitWords('  one   two\nthree ')).toEqual(['one', 'two', 'three']);
  });
});

describe('wordsSpokenAtChar', () => {
  it('counts the word a boundary lands on as spoken', () => {
    expect(wordsSpokenAtChar('Hello there, friend', 6)).toBe(2);
  });

  it('counts the first word at the start of the text', () => {
    expect(wordsSpokenAtChar('Hello there', 0)).toBe(1);
  });

  it('never exceeds the number of words', () => {
    expect(wordsSpokenAtChar('Hello there', 500)).toBe(2);
  });
});

describe('estimatedWordsSpoken', () => {
  it('has the first word under way the moment speech starts', () => {
    expect(estimatedWordsSpoken('one two three', 0)).toBe(1);
  });

  it('moves on one word per word-length of time', () => {
    expect(estimatedWordsSpoken('one two three', 400)).toBe(2);
  });

  it('pauses after a full stop', () => {
    expect(estimatedWordsSpoken('Hi. two three', 400)).toBe(1);
  });

  it('stops at the last word', () => {
    expect(estimatedWordsSpoken('one two', 60_000)).toBe(2);
  });
});

describe('wordsSpokenAtFraction', () => {
  it('reveals nothing before playback starts', () => {
    expect(wordsSpokenAtFraction('one two three four', 0)).toBe(0);
  });

  it('reveals everything at the end of playback', () => {
    expect(wordsSpokenAtFraction('one two three four', 1)).toBe(4);
  });

  it('reveals in proportion to the characters played', () => {
    expect(wordsSpokenAtFraction('aaaa bbbb cccc dddd', 0.5)).toBe(2);
  });
});

describe('rmsLevel', () => {
  it('is zero for silence around the 128 midpoint', () => {
    expect(rmsLevel(new Uint8Array([128, 128, 128, 128]))).toBe(0);
  });

  it('is capped at 1 for a loud signal', () => {
    expect(rmsLevel(new Uint8Array([0, 255, 0, 255]))).toBe(1);
  });
});

const browserState = (over: Partial<VoiceState> = {}): VoiceState => ({
  text: 'Tell me about your current role.',
  startedAt: 1000,
  source: 'browser',
  boundary: null,
  audioFraction: null,
  analyserLevel: null,
  ...over,
});

describe('voiceTarget', () => {
  it('is silent when nothing is being spoken', () => {
    expect(voiceTarget(null, 5000)).toBe(0);
  });

  it('follows the analyser when real audio is measured', () => {
    expect(voiceTarget(browserState({ source: 'server', analyserLevel: 0.6 }), 5000)).toBe(0.6);
  });

  it('uses the word a recent boundary landed on', () => {
    const state = browserState({ boundary: { charIndex: 5, at: 4900 } });
    expect(voiceTarget(state, 5000)).toBe(wordEnvelope('me'));
  });

  it('falls to a low murmur when boundaries have gone quiet', () => {
    const state = browserState({ boundary: { charIndex: 5, at: 1000 } });
    expect(voiceTarget(state, 5000)).toBe(0.15);
  });

  it('estimates from elapsed time when the voice sends no boundaries', () => {
    expect(voiceTarget(browserState(), 1000)).toBe(wordEnvelope('Tell'));
  });
});

describe('spokenWords', () => {
  it('is unknown when nothing is being spoken', () => {
    expect(spokenWords(null, 5000)).toBeNull();
  });

  it('follows the boundary for the browser voice', () => {
    expect(spokenWords(browserState({ boundary: { charIndex: 8, at: 1200 } }), 1300)).toBe(3);
  });

  it('follows playback position for server audio', () => {
    expect(spokenWords(browserState({ source: 'server', audioFraction: 1 }), 1300)).toBe(6);
  });

  it('falls back to a time estimate', () => {
    expect(spokenWords(browserState(), 1000)).toBe(1);
  });
});
