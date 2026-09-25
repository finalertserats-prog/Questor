import { describe, it, expect, afterEach, vi } from 'vitest';
import { levelSpeechClip, DECODE_SAMPLE_RATE } from '../src/levelSpeechClip';

/**
 * The browser side of levelling: decode the vendor clip, level it, and hand
 * back a WAV for the same <audio> element. Whatever goes wrong, the candidate
 * must still hear the question — so every failure plays the original clip.
 */

const RATE = 24_000;

function loudTone(seconds: number, amp: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return out;
}

/** A stand-in for OfflineAudioContext whose decode returns the given channels. */
function fakeOfflineContext(decode: () => Promise<{ sampleRate: number; numberOfChannels: number; getChannelData(c: number): Float32Array }>) {
  const made: Array<{ channels: number; length: number; rate: number }> = [];
  class FakeOffline {
    constructor(channels: number, length: number, rate: number) { made.push({ channels, length, rate }); }
    decodeAudioData() { return decode(); }
  }
  vi.stubGlobal('OfflineAudioContext', FakeOffline);
  return made;
}

const mono = (samples: Float32Array) => async () => ({ sampleRate: RATE, numberOfChannels: 1, getChannelData: () => samples });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('levelSpeechClip', () => {
  it('returns a WAV clip when the browser can decode', async () => {
    fakeOfflineContext(mono(loudTone(1, 0.5)));
    const out = await levelSpeechClip(new Blob([new Uint8Array(8)], { type: 'audio/mpeg' }));
    expect(out.type).toBe('audio/wav');
  });

  it('decodes at a rate that keeps the full-band vendor audio', async () => {
    const made = fakeOfflineContext(mono(loudTone(1, 0.5)));
    await levelSpeechClip(new Blob([new Uint8Array(8)]));
    expect(made[0].rate).toBe(DECODE_SAMPLE_RATE);
  });

  it('writes the levelled samples, not the originals', async () => {
    const input = loudTone(1, 0.9); // ~-4 dBFS: far above the target
    fakeOfflineContext(mono(input));
    const out = await levelSpeechClip(new Blob([new Uint8Array(8)]));
    const view = new DataView(await out.arrayBuffer());
    let peak = 0;
    for (let i = 44; i < view.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
    expect(peak / 32768).toBeLessThan(0.5);
  });

  it('mixes a stereo clip down to one channel of the same length', async () => {
    const left = loudTone(1, 0.2);
    fakeOfflineContext(async () => ({ sampleRate: RATE, numberOfChannels: 2, getChannelData: () => left }));
    const out = await levelSpeechClip(new Blob([new Uint8Array(8)]));
    expect(out.size).toBe(44 + left.length * 2);
  });

  it('plays the original when the browser has no OfflineAudioContext', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined);
    const original = new Blob([new Uint8Array(8)], { type: 'audio/mpeg' });
    expect(await levelSpeechClip(original)).toBe(original);
  });

  it('plays the original when decoding fails', async () => {
    fakeOfflineContext(() => Promise.reject(new Error('EncodingError')));
    const original = new Blob([new Uint8Array(8)], { type: 'audio/mpeg' });
    expect(await levelSpeechClip(original)).toBe(original);
  });

  it('plays the original when decoding outlasts the latency budget', async () => {
    vi.useFakeTimers();
    fakeOfflineContext(() => new Promise(() => undefined));
    const original = new Blob([new Uint8Array(8)], { type: 'audio/mpeg' });
    const pending = levelSpeechClip(original, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(original);
  });

  it('plays the original for a silent clip, which has nothing to level', async () => {
    fakeOfflineContext(mono(new Float32Array(RATE)));
    const original = new Blob([new Uint8Array(8)], { type: 'audio/mpeg' });
    expect(await levelSpeechClip(original)).toBe(original);
  });
});
