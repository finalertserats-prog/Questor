import { describe, it, expect } from 'vitest';
import {
  measureLoudness, levelSpeech, encodeWav,
  TARGET_LOUDNESS_DB, PEAK_CEILING, MAX_CLIP_BOOST_DB,
} from '../src/voiceLevelling';

/**
 * The interviewer's voice was "super low at times and high at times" in a
 * real interview (owner, 2026-09-22). Each turn is a separately generated
 * clip, played raw: measured on the repo's own OpenAI clips, the clips differ
 * by ~2 dB from each other and, inside one clip, the level swings ~10 dB
 * (p10 to p90 of 400 ms loudness) and up to ~19 dB where a line trails off.
 * These cases pin the levelling that makes every turn sound equally loud.
 */

const RATE = 24_000;

/** Speech-like test signal: a tone whose level can change part-way through. */
function tone(segments: ReadonlyArray<{ seconds: number; db: number }>, hz = 220): Float32Array {
  const total = segments.reduce((n, s) => n + Math.round(s.seconds * RATE), 0);
  const out = new Float32Array(total);
  let i = 0;
  for (const s of segments) {
    // Peak amplitude for a sine whose RMS is `db`.
    const amp = Math.SQRT2 * 10 ** (s.db / 20);
    const n = Math.round(s.seconds * RATE);
    for (let k = 0; k < n; k++, i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return out;
}

function peakOf(x: Float32Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

/** RMS in dB of a slice, for comparing two parts of one clip. */
function sliceDb(x: Float32Array, fromS: number, toS: number): number {
  let sum = 0;
  const a = Math.round(fromS * RATE);
  const b = Math.round(toS * RATE);
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / (b - a));
}

describe('measureLoudness', () => {
  it('reads a steady tone at its RMS level', () => {
    expect(measureLoudness(tone([{ seconds: 2, db: -20 }]), RATE)).toBeCloseTo(-20, 1);
  });

  it('returns null for silence', () => {
    expect(measureLoudness(new Float32Array(RATE), RATE)).toBeNull();
  });

  it('ignores pauses between sentences', () => {
    const withPause = tone([{ seconds: 1, db: -20 }, { seconds: 1, db: -120 }, { seconds: 1, db: -20 }]);
    // Within 1 dB: only the blocks that straddle a pause edge pull it down.
    expect(Math.abs((measureLoudness(withPause, RATE) ?? 0) + 20)).toBeLessThan(1);
  });

  it('measures a clip shorter than one block', () => {
    expect(measureLoudness(tone([{ seconds: 0.2, db: -18 }]), RATE)).toBeCloseTo(-18, 0);
  });
});

describe('levelSpeech', () => {
  it('brings a quiet clip up to the target loudness', () => {
    const out = levelSpeech(tone([{ seconds: 3, db: -28 }]), RATE);
    expect(measureLoudness(out, RATE)).toBeCloseTo(TARGET_LOUDNESS_DB, 0);
  });

  it('brings a loud clip down to the target loudness', () => {
    const out = levelSpeech(tone([{ seconds: 3, db: -12 }]), RATE);
    expect(measureLoudness(out, RATE)).toBeCloseTo(TARGET_LOUDNESS_DB, 0);
  });

  it('plays two clips 16 dB apart within 1 dB of each other (regression: turns at different loudness)', () => {
    const quiet = measureLoudness(levelSpeech(tone([{ seconds: 3, db: -30 }]), RATE), RATE) ?? 0;
    const loud = measureLoudness(levelSpeech(tone([{ seconds: 3, db: -14 }]), RATE), RATE) ?? 0;
    expect(Math.abs(quiet - loud)).toBeLessThan(1);
  });

  it('narrows a 12 dB swing inside one clip to at most 7 dB (regression: a line trailing off)', () => {
    const out = levelSpeech(tone([{ seconds: 2, db: -18 }, { seconds: 2, db: -30 }]), RATE);
    const swing = sliceDb(out, 0.5, 1.5) - sliceDb(out, 2.5, 3.5);
    expect(swing).toBeLessThanOrEqual(7);
  });

  it('keeps the louder part louder, so speech is not flattened', () => {
    const out = levelSpeech(tone([{ seconds: 2, db: -18 }, { seconds: 2, db: -30 }]), RATE);
    expect(sliceDb(out, 0.5, 1.5) - sliceDb(out, 2.5, 3.5)).toBeGreaterThan(3);
  });

  it('never boosts a clip by more than the cap', () => {
    const out = levelSpeech(tone([{ seconds: 3, db: -45 }]), RATE);
    expect(measureLoudness(out, RATE) ?? 0).toBeLessThanOrEqual(-45 + MAX_CLIP_BOOST_DB + 0.5);
  });

  it('never clips: peaks stay under the ceiling after a boost', () => {
    const spiky = tone([{ seconds: 3, db: -30 }]);
    spiky[RATE] = 0.9; // a click far above the speech level
    expect(peakOf(levelSpeech(spiky, RATE))).toBeLessThanOrEqual(PEAK_CEILING + 1e-6);
  });

  it('never clips a clip that is already at full scale', () => {
    const hot = tone([{ seconds: 2, db: -3 }]);
    expect(peakOf(levelSpeech(hot, RATE))).toBeLessThanOrEqual(PEAK_CEILING + 1e-6);
  });

  it('does not lift the silence in a pause', () => {
    const out = levelSpeech(tone([{ seconds: 1, db: -26 }, { seconds: 1, db: -80 }, { seconds: 1, db: -26 }]), RATE);
    expect(sliceDb(out, 1.3, 1.7)).toBeLessThan(-60);
  });

  it('returns silence unchanged', () => {
    const silent = new Float32Array(RATE);
    expect(peakOf(levelSpeech(silent, RATE))).toBe(0);
  });

  it('does not modify the input samples', () => {
    const input = tone([{ seconds: 1, db: -30 }]);
    const before = input.slice();
    levelSpeech(input, RATE);
    expect(Array.from(input)).toEqual(Array.from(before));
  });

  it('keeps the clip length', () => {
    expect(levelSpeech(tone([{ seconds: 1.37, db: -24 }]), RATE).length).toBe(Math.round(1.37 * RATE));
  });
});

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header with the sample rate', () => {
    const view = new DataView(encodeWav(new Float32Array(10), 44_100));
    const tag = (at: number) => String.fromCharCode(...new Uint8Array(view.buffer, at, 4));
    expect([tag(0), tag(8), tag(36), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)])
      .toEqual(['RIFF', 'WAVE', 'data', 1, 44_100, 16]);
  });

  it('holds two bytes per sample after the header', () => {
    expect(encodeWav(new Float32Array(100), RATE).byteLength).toBe(44 + 200);
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const view = new DataView(encodeWav(Float32Array.from([2, -2]), RATE));
    expect([view.getInt16(44, true), view.getInt16(46, true)]).toEqual([32767, -32768]);
  });
});
