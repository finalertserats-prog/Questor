import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Turn-taking tests.
 *
 * Every case here is a bug that reached a real candidate on 19 July 2026. Two
 * of them were reported within an hour of the invitations going out:
 *
 *   "the Done Answering button isn't working"          -> submitsInterimOnStop
 *   "before he completes the first question it goes
 *    for the second question"                          -> doesNotSubmitOnPause
 *
 * The recognizer is pure logic over the browser SpeechRecognition API, so it
 * needs a fake of that API and nothing else — no DOM, no jsdom.
 */

// ---------------------------------------------------------------------------
// A controllable stand-in for the browser's SpeechRecognition.

class FakeRecognition {
  static live: FakeRecognition[] = [];

  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;

  started = 0;
  running = false;

  constructor() { FakeRecognition.live.push(this); }

  start() {
    // The real API throws if start() is called while already running, and the
    // production code relies on that being survivable.
    if (this.running) throw new Error('InvalidStateError');
    this.running = true;
    this.started += 1;
  }
  stop() { this.running = false; this.fireEnd(); }
  abort() { this.running = false; this.fireEnd(); }

  // --- test controls -------------------------------------------------------

  /** Deliver speech. `final` mirrors the API's isFinal flag. */
  say(text: string, final: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: text }, isFinal: final, length: 1 }],
    });
  }

  /** Chrome ending a continuous session on its own after a quiet moment. */
  endSpontaneously() { this.running = false; this.fireEnd(); }

  fail(error: string) { this.onerror?.({ error }); }

  private fireEnd() { this.onend?.(); }
}

async function loadSpeech() {
  vi.resetModules();
  FakeRecognition.live = [];
  // speech.ts reads `window` at module scope, so the stub has to exist before
  // the import rather than being injected afterwards.
  (globalThis as unknown as { window: unknown }).window = {
    SpeechRecognition: FakeRecognition,
    speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [] },
  };
  return import('../src/speech');
}

/** The recognition object the code is currently driving. */
const current = () => FakeRecognition.live[FakeRecognition.live.length - 1];

describe('createRecognizer turn-taking', () => {
  beforeEach(() => { FakeRecognition.live = []; });

  it('submits interim text when the candidate presses Done answering', async () => {
    // Sisir's bug. Chrome had not finalised anything yet, so the old code found
    // an empty buffer, skipped onFinal entirely, and the button did nothing.
    const { createRecognizer } = await loadSpeech();
    const onFinal = vi.fn();
    const rec = createRecognizer({ onFinal })!;
    rec.start();

    current().say('I owned the reconciliation pipeline', false); // never finalised
    rec.stop();

    expect(onFinal).toHaveBeenCalledWith('I owned the reconciliation pipeline');
  });

  it('does not submit when the browser ends the session during a pause', async () => {
    // Mahesh's bug: a pause to think was treated as the end of the answer, so
    // the interview advanced to the next question mid-thought.
    const { createRecognizer } = await loadSpeech();
    const onFinal = vi.fn();
    const rec = createRecognizer({ onFinal })!;
    rec.start();

    current().say('We used Snowflake because', true);
    current().endSpontaneously();

    expect(onFinal).not.toHaveBeenCalled();
  });

  it('resumes listening after that pause', async () => {
    const { createRecognizer } = await loadSpeech();
    const rec = createRecognizer({ onFinal: vi.fn() })!;
    rec.start();

    const first = current();
    first.say('thinking out loud', true);
    first.endSpontaneously();

    expect(first.started).toBe(2); // restarted on the same object
  });

  it('keeps text spoken before a pause, without duplicating it', async () => {
    // A restarted session numbers its results from zero and knows nothing of
    // the previous one, so text has to be banked across the restart — banked
    // wrongly it is either lost or counted twice, and either way it is scored.
    const { createRecognizer } = await loadSpeech();
    const onFinal = vi.fn();
    const rec = createRecognizer({ onFinal })!;
    rec.start();

    current().say('first part', true);
    current().endSpontaneously();   // pause
    current().say('second part', true);
    rec.stop();

    expect(onFinal).toHaveBeenCalledWith('first part second part');
  });

  it('calls onFinal even with nothing captured, so the caller can fall back', async () => {
    // Staying silent here is precisely what made the button appear dead: the
    // caller has a recorded-audio fallback and never got the chance to use it.
    const { createRecognizer } = await loadSpeech();
    const onFinal = vi.fn();
    const rec = createRecognizer({ onFinal })!;
    rec.start();
    rec.stop();

    expect(onFinal).toHaveBeenCalledWith('');
  });

  it('treats no-speech as a quiet moment rather than a failure', async () => {
    const { createRecognizer } = await loadSpeech();
    const onError = vi.fn();
    const rec = createRecognizer({ onFinal: vi.fn(), onError })!;
    rec.start();

    current().fail('no-speech');

    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a broken microphone without ending the turn', async () => {
    const { createRecognizer } = await loadSpeech();
    const onFinal = vi.fn();
    const onDead = vi.fn();
    const rec = createRecognizer({ onFinal, onDead })!;
    rec.start();

    current().say('half an answer', true);
    current().fail('audio-capture');

    expect(onDead).toHaveBeenCalled();
    // The half-answer must NOT be submitted as though it were complete.
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('asks whether the candidate is still there instead of submitting on long silence', async () => {
    // The first version of this fix submitted after a timeout, which is the
    // same bug on a delay. Silence is not consent to submit.
    const { createRecognizer } = await loadSpeech();
    const onFinal = vi.fn();
    const onSilence = vi.fn();
    const rec = createRecognizer({ onFinal, onSilence })!;
    rec.start();

    current().say('I was going to say', true);

    // Jump past the silence threshold.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try { current().endSpontaneously(); } finally { Date.now = realNow; }

    expect(onSilence).toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('preserves what was said when the candidate goes quiet then finishes', async () => {
    const { createRecognizer } = await loadSpeech();
    const onFinal = vi.fn();
    const rec = createRecognizer({ onFinal, onSilence: vi.fn() })!;
    rec.start();

    current().say('a long pause follows this', true);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try { current().endSpontaneously(); } finally { Date.now = realNow; }

    rec.stop();
    expect(onFinal).toHaveBeenCalledWith('a long pause follows this');
  });

  it('stops restarting when the microphone is dead rather than merely quiet', async () => {
    // Without a ceiling this is an unbounded restart loop against a device that
    // will never produce audio.
    const { createRecognizer } = await loadSpeech();
    const onDead = vi.fn();
    const rec = createRecognizer({ onFinal: vi.fn(), onDead })!;
    rec.start();

    for (let i = 0; i < 25; i++) current().endSpontaneously();

    expect(onDead).toHaveBeenCalled();
    expect(current().started).toBeLessThanOrEqual(21); // 1 initial + the cap
  });

  it('exposes what has been heard so far, for the Done answering watchdog', async () => {
    const { createRecognizer } = await loadSpeech();
    const rec = createRecognizer({ onFinal: vi.fn() })!;
    rec.start();

    current().say('finalised bit', true);
    current().say('and the interim tail', false);

    expect(rec.text()).toBe('finalised bit and the interim tail');
  });
});
