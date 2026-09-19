import { describe, it, expect } from 'vitest';
import {
  createObserverCapture, type CaptureDeps, type CaptureState, type ChunkRecorder, type RecognizerHandlers,
} from '../src/observerCapture';

/**
 * The observer room's capture loop, driven with fakes for the microphone, the
 * recogniser, the clock and the network.
 *
 * What matters most: once capture is stopped, nothing more leaves the device,
 * and a failure to transcribe is reported as a gap rather than papered over.
 */

class FakeClock {
  now = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 0;

  schedule = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers = [...this.timers, { at: this.now + ms, fn, id }];
    return () => { this.timers = this.timers.filter((t) => t.id !== id); };
  };

  async advance(ms: number) {
    this.now += ms;
    const due = this.timers.filter((t) => t.at <= this.now);
    this.timers = this.timers.filter((t) => t.at > this.now);
    for (const timer of due) timer.fn();
    await flush();
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakeMicrophone() {
  let chunk = 0;
  const events: string[] = [];
  const recorder: ChunkRecorder = {
    next: async () => { chunk += 1; events.push(`next${chunk}`); return new Blob([`chunk${chunk}`]); },
    finish: async () => { chunk += 1; events.push('finish'); return new Blob([`chunk${chunk}`]); },
    close: async () => { events.push('close'); },
  };
  return { recorder, events };
}

interface Sent { kind: 'audio' | 'text' | 'gap'; offsetMs: number; durationMs: number; text?: string }

function setup(overrides: Partial<CaptureDeps> = {}) {
  const clock = new FakeClock();
  const sent: Sent[] = [];
  const states: CaptureState[] = [];
  const mic = fakeMicrophone();
  const deps: CaptureDeps = {
    mode: 'server',
    chunkMs: 30_000,
    now: () => clock.now,
    schedule: clock.schedule,
    openMicrophone: async () => mic.recorder,
    createRecognizer: () => null,
    sendAudio: async (_blob, offsetMs, durationMs) => { sent.push({ kind: 'audio', offsetMs, durationMs }); return 'ok'; },
    sendText: async (text, offsetMs, durationMs) => { sent.push({ kind: 'text', text, offsetMs, durationMs }); return 'ok'; },
    reportGap: async (offsetMs, durationMs) => { sent.push({ kind: 'gap', offsetMs, durationMs }); },
    onState: (state) => { states.push(state); },
    ...overrides,
  };
  return { clock, sent, states, mic, capture: createObserverCapture(deps) };
}

describe('capturing on the server', () => {
  it('uploads a chunk at every interval, stamped with where it starts in the round', async () => {
    const { clock, sent, capture } = setup();
    await capture.start();

    await clock.advance(30_000);
    await clock.advance(30_000);

    expect(sent.map((s) => s.offsetMs)).toEqual([0, 30_000]);
  });

  it('sends nothing more once stopped, and throws away the chunk in progress', async () => {
    const { clock, sent, mic, capture } = setup();
    await capture.start();
    await clock.advance(30_000);

    await capture.stop({ flush: false });
    await clock.advance(60_000);

    expect(sent).toHaveLength(1);
    expect(mic.events).toContain('close');
  });

  it('uploads the last partial chunk when the round ends normally', async () => {
    const { clock, sent, capture } = setup();
    await capture.start();
    await clock.advance(10_000);

    await capture.stop({ flush: true });

    expect(sent).toEqual([{ kind: 'audio', offsetMs: 0, durationMs: 10_000 }]);
  });

  it('stops capturing when the server refuses a chunk, because someone stopped the observer', async () => {
    const { clock, states, mic, capture } = setup({ sendAudio: async () => 'refused' });
    await capture.start();

    await clock.advance(30_000);

    expect(states.at(-1)).toEqual({ kind: 'stopped', reason: 'refused' });
    expect(mic.events).toContain('close');
  });

  it('keeps listening, and says so, when a chunk could not be transcribed', async () => {
    const { clock, states, sent, capture } = setup({
      sendAudio: async (_b, offsetMs, durationMs) => { sent.push({ kind: 'audio', offsetMs, durationMs }); return 'gap'; },
    });
    await capture.start();

    await clock.advance(30_000);
    await clock.advance(30_000);

    expect(states.at(-1)?.kind).toBe('degraded');
    expect(sent).toHaveLength(2);
  });

  it('reports that it could not capture when there is no microphone', async () => {
    const { sent, states, capture } = setup({ openMicrophone: async () => null });

    const started = await capture.start();

    expect(started).toBe(false);
    expect(states.at(-1)).toEqual({ kind: 'stopped', reason: 'unavailable' });
    // The round's record says capture failed, rather than looking silent.
    expect(sent).toEqual([{ kind: 'gap', offsetMs: 0, durationMs: 0 }]);
  });
});

describe('capturing with browser speech recognition', () => {
  function recognizerSetup() {
    let handlers: RecognizerHandlers | null = null;
    const heard: string[] = [];
    let running = false;
    const recognizer = {
      start: () => { running = true; },
      stop: () => { if (!running) return; running = false; handlers?.onFinal(heard.shift() ?? ''); },
      abort: () => { if (!running) return; running = false; handlers?.onFinal(heard.shift() ?? ''); },
    };
    const env = setup({
      mode: 'browser',
      createRecognizer: (h) => { handlers = h; return recognizer; },
    });
    return { ...env, heard, fail: (reason: string) => handlers?.onDead?.(reason), isRunning: () => running };
  }

  it('sends what was heard in each interval', async () => {
    const { clock, sent, heard, capture } = recognizerSetup();
    heard.push('I led the rollback myself.');
    await capture.start();

    await clock.advance(30_000);

    expect(sent).toEqual([{ kind: 'text', text: 'I led the rollback myself.', offsetMs: 0, durationMs: 30_000 }]);
  });

  it('keeps listening after each interval', async () => {
    const { clock, capture, isRunning } = recognizerSetup();
    await capture.start();

    await clock.advance(30_000);

    expect(isRunning()).toBe(true);
  });

  it('discards what was heard when stopped', async () => {
    const { sent, heard, capture, isRunning } = recognizerSetup();
    await capture.start();
    heard.push('Said just before the stop.');

    await capture.stop({ flush: false });

    expect(sent).toEqual([]);
    expect(isRunning()).toBe(false);
  });

  it('reports a gap when recognition dies', async () => {
    const { clock, sent, states, capture, fail } = recognizerSetup();
    await capture.start();
    await clock.advance(5_000);

    fail('network');
    await flush();

    expect(sent.at(-1)?.kind).toBe('gap');
    expect(states.at(-1)?.kind).toBe('degraded');
  });

  it('reports it could not capture when the browser has no recognition', async () => {
    const { states, capture } = setup({ mode: 'browser', createRecognizer: () => null });

    expect(await capture.start()).toBe(false);
    expect(states.at(-1)).toEqual({ kind: 'stopped', reason: 'unavailable' });
  });
});
