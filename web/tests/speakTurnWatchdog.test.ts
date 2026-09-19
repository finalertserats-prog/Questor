import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * speakTurn's watchdog.
 *
 * The server voice plays through an <audio> element. On iOS the audio context
 * it is routed through can be suspended mid-utterance, and the element then
 * never fires 'ended': the room sat in 'speaking' forever, with the candidate
 * unable to answer. These cases pin the watchdog that ends it anyway.
 */

class FakeAudio {
  static live: FakeAudio[] = [];
  duration = Number.NaN;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  constructor(readonly src: string) { FakeAudio.live.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  /** The browser has read the file's header. */
  metadata(seconds: number) { this.duration = seconds; this.onloadedmetadata?.(); }
}

async function loadSpeech() {
  vi.resetModules();
  FakeAudio.live = [];
  (globalThis as unknown as { window: unknown }).window = {
    speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [] },
  };
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, blob: async () => new Blob(['x']) })));
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
  return import('../src/speech');
}

const audio = () => FakeAudio.live[FakeAudio.live.length - 1];

/** Start a turn and let the fetch and play() settle. */
async function speakText(speech: Awaited<ReturnType<typeof loadSpeech>>, text: string, onDone: () => void) {
  await speech.speakTurn({ token: 't', turnId: 'a', text, onDone });
}

describe('speakTurn watchdog', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('finishes when the audio outlives its duration and never ends', async () => {
    const speech = await loadSpeech();
    const onDone = vi.fn();
    await speakText(speech, 'Tell me about a project.', onDone);
    audio().metadata(4);
    vi.advanceTimersByTime(4_000 + 1_500);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('does not cut off audio that is still inside its duration and grace', async () => {
    const speech = await loadSpeech();
    const onDone = vi.fn();
    await speakText(speech, 'Tell me about a project.', onDone);
    audio().metadata(4);
    vi.advanceTimersByTime(4_000 + 1_400);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('gives up by a cap on the text length when no duration is known', async () => {
    const speech = await loadSpeech();
    const onDone = vi.fn();
    const text = 'x'.repeat(100);
    await speakText(speech, text, onDone);
    vi.advanceTimersByTime(100 * 80 + 3_000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('waits at least five seconds for a short line with no duration', async () => {
    const speech = await loadSpeech();
    const onDone = vi.fn();
    await speakText(speech, 'Hi.', onDone);
    vi.advanceTimersByTime(4_900);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('does not wait out the cap for a line with no duration', async () => {
    const speech = await loadSpeech();
    const onDone = vi.fn();
    await speakText(speech, 'Hi.', onDone);
    vi.advanceTimersByTime(5_000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('calls onDone once when the audio ends and the watchdog would also fire', async () => {
    const speech = await loadSpeech();
    const onDone = vi.fn();
    await speakText(speech, 'Tell me about a project.', onDone);
    audio().metadata(4);
    audio().onended?.();
    vi.advanceTimersByTime(60_000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('tells the room the voice stopped when the watchdog fires', async () => {
    const speech = await loadSpeech();
    const events: string[] = [];
    speech.onSpeechActivity((e) => { events.push(e.type); });
    await speakText(speech, 'Tell me about a project.', () => undefined);
    audio().metadata(4);
    vi.advanceTimersByTime(10_000);
    expect(events).toEqual(['start', 'end']);
  });

  it('silences the stuck element so it cannot talk over the next question', async () => {
    const speech = await loadSpeech();
    await speakText(speech, 'Tell me about a project.', () => undefined);
    audio().metadata(4);
    vi.advanceTimersByTime(10_000);
    expect(audio().paused).toBe(true);
  });

  it('does not fire onDone after the room stopped the voice itself', async () => {
    const speech = await loadSpeech();
    const onDone = vi.fn();
    await speakText(speech, 'Tell me about a project.', onDone);
    speech.stopAllSpeech();
    vi.advanceTimersByTime(60_000);
    expect(onDone).not.toHaveBeenCalled();
  });
});
