import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Regression for "the audio was going super low at times and high at times"
 * (owner, real interview, 2026-09-22). The root cause was that every server
 * clip — interviewer turns and silence check-ins alike — went straight from
 * the response into an <audio> element, unlevelled. These cases pin that
 * what plays is the levelled clip.
 */

const RATE = 24_000;

class FakeAudio {
  static live: FakeAudio[] = [];
  duration = Number.NaN;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  constructor(readonly src: string) { FakeAudio.live.push(this); }
  play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
  pause() {}
}

function tone(amp: number): Float32Array {
  const out = new Float32Array(RATE);
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return out;
}

async function loadSpeech(opts: { decodes: boolean }) {
  vi.resetModules();
  FakeAudio.live = [];
  (globalThis as unknown as { window: unknown }).window = {
    speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [] },
  };
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200, ok: true,
    headers: { get: () => encodeURIComponent('Are you still there?') },
    blob: async () => new Blob([new Uint8Array(8)], { type: 'audio/mpeg' }),
  })));
  const played: Blob[] = [];
  vi.stubGlobal('URL', { createObjectURL: (b: Blob) => { played.push(b); return `blob:${played.length}`; }, revokeObjectURL: () => undefined });
  if (opts.decodes) {
    vi.stubGlobal('OfflineAudioContext', class {
      decodeAudioData() { return Promise.resolve({ sampleRate: RATE, numberOfChannels: 1, getChannelData: () => tone(0.05) }); }
    });
  } else {
    vi.stubGlobal('OfflineAudioContext', undefined);
  }
  return { speech: await import('../src/speech'), played };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('interviewer clips are levelled before they play', () => {
  it('plays an interviewer turn as the levelled clip', async () => {
    const { speech, played } = await loadSpeech({ decodes: true });
    await speech.speakTurn({ token: 't', turnId: 'a', text: 'Tell me about a project.' });
    expect(played[0].type).toBe('audio/wav');
  });

  it('plays a silence check-in as the levelled clip', async () => {
    const { speech, played } = await loadSpeech({ decodes: true });
    await speech.speakNudge('t', 0);
    expect(played[0].type).toBe('audio/wav');
  });

  it('still plays the vendor clip when the browser cannot level it', async () => {
    const { speech, played } = await loadSpeech({ decodes: false });
    await speech.speakTurn({ token: 't', turnId: 'a', text: 'Tell me about a project.' });
    expect(played[0].type).toBe('audio/mpeg');
  });
});
