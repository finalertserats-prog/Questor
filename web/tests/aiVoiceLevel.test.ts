// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpeechActivity } from '../src/speech';

/** Following the interviewer's voice without leaking audio graphs or silencing it. */

const bus = vi.hoisted(() => ({ listener: null as ((e: SpeechActivity) => void) | null }));
vi.mock('../src/speech', () => ({
  onSpeechActivity: (l: ((e: SpeechActivity) => void) | null) => { bus.listener = l; },
}));

class FakeNode {
  disconnected = false;
  connect() { return this; }
  disconnect() { this.disconnected = true; }
  frequencyBinCount = 4;
  fftSize = 0;
  getByteTimeDomainData() {}
}

class FakeContext {
  static made: FakeContext[] = [];
  state: 'running' | 'suspended' | 'interrupted' = 'running';
  onstatechange: (() => void) | null = null;
  destination = new FakeNode();
  sources: FakeNode[] = [];
  analysers: FakeNode[] = [];
  constructor() { FakeContext.made.push(this); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaElementSource() { const n = new FakeNode(); this.sources.push(n); return n; }
  createAnalyser() { const n = new FakeNode(); this.analysers.push(n); return n; }
}

const { AiVoiceLevel } = await import('../src/components/room/aiVoiceLevel');

function setup() {
  FakeContext.made = [];
  vi.stubGlobal('AudioContext', FakeContext);
  const level = new AiVoiceLevel();
  level.prime();
  level.listen();
  const ctx = FakeContext.made[0];
  const emit = (e: SpeechActivity) => bus.listener?.(e);
  return { level, ctx, emit };
}

const audio = () => document.createElement('audio');

beforeEach(() => { bus.listener = null; });

describe('AiVoiceLevel', () => {
  it('ignores the end of an earlier utterance', () => {
    const { level, emit } = setup();
    emit({ type: 'start', id: 1, text: 'first', audio: null });
    emit({ type: 'start', id: 2, text: 'second one', audio: null });
    emit({ type: 'end', id: 1 });
    expect(level.spoken('second one')).not.toBeNull();
  });

  it('disconnects the audio graph when the utterance ends', () => {
    const { ctx, emit } = setup();
    emit({ type: 'start', id: 1, text: 'hello', audio: audio() });
    emit({ type: 'end', id: 1 });
    expect(ctx.sources[0].disconnected && ctx.analysers[0].disconnected).toBe(true);
  });

  it('disconnects an earlier graph when a new utterance starts without an end', () => {
    const { ctx, emit } = setup();
    emit({ type: 'start', id: 1, text: 'hello', audio: audio() });
    emit({ type: 'start', id: 2, text: 'again', audio: audio() });
    expect(ctx.sources[0].disconnected).toBe(true);
  });

  it('stops routing audio through a context that was suspended mid-interview', () => {
    const { ctx, emit } = setup();
    ctx.state = 'suspended';
    ctx.onstatechange?.();
    ctx.state = 'running';
    emit({ type: 'start', id: 1, text: 'hello', audio: audio() });
    expect(ctx.sources).toHaveLength(0);
  });
});
