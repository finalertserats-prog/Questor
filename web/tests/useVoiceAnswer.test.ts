// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { RoomPhase } from '../src/components/room/roomConversationModel';

/**
 * The spoken-answer hook, against a fake recognizer and recorder: every path
 * that stops listening must hand the candidate's words on, never drop them.
 */

interface FakeRecognizer {
  handlers: {
    onFinal: (t: string) => void;
    onInterim?: (t: string) => void;
    onSilence?: () => void;
    onDead?: (r: string) => void;
    onError?: (e: string) => void;
  };
  heard: string;
  aborted: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  text(): string;
}

const speech = vi.hoisted(() => ({
  recognizers: [] as FakeRecognizer[],
  recordings: [] as Array<{ stopped: boolean; blob: Blob | null }>,
  // Resolvers for startRecording calls, so a test can hold the mic "opening".
  pendingStarts: [] as Array<() => void>,
  holdStarts: false,
  transcribe: vi.fn(async () => 'transcribed words' as string | null),
  nudge: vi.fn(async () => 'Take your time.'),
}));

vi.mock('../src/speech', () => ({
  createRecognizer: (handlers: FakeRecognizer['handlers']) => {
    const rec: FakeRecognizer = {
      handlers, heard: '', aborted: false,
      start() {},
      stop() { handlers.onFinal(rec.heard); },
      // A real aborted recognizer still reports what it had as final.
      abort() { rec.aborted = true; handlers.onFinal(rec.heard); },
      text() { return rec.heard; },
    };
    speech.recognizers.push(rec);
    return rec;
  },
  startRecording: () => new Promise((resolve) => {
    const recording = { stopped: false, blob: new Blob(['audio']) as Blob | null };
    const handle = {
      stop: async () => { recording.stopped = true; return recording.blob; },
    };
    const open = () => { speech.recordings.push(recording); resolve(handle); };
    if (speech.holdStarts) speech.pendingStarts.push(open); else open();
  }),
  transcribeOnServer: speech.transcribe,
  speakNudge: speech.nudge,
}));

const { useVoiceAnswer } = await import('../src/components/room/useVoiceAnswer');

function makeDeps() {
  const phaseRef = { current: 'listening' as RoomPhase };
  const textModeRef = { current: false };
  return {
    token: 't',
    phaseRef,
    textModeRef,
    canCaptureRef: { current: true },
    pausedRef: { current: false },
    speechSeqRef: { current: 0 },
    setPhase: vi.fn((p: RoomPhase) => { phaseRef.current = p; }),
    setTextMode: vi.fn((on: boolean) => { textModeRef.current = on; }),
    setInterim: vi.fn(),
    setErr: vi.fn(),
    submitAnswer: vi.fn(),
    addNudge: vi.fn(),
    mergeIntoDraft: vi.fn(),
    onMicDead: vi.fn(),
  };
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  speech.recognizers.length = 0;
  speech.recordings.length = 0;
  speech.pendingStarts.length = 0;
  speech.holdStarts = false;
  speech.transcribe.mockReset().mockResolvedValue('transcribed words');
});
afterEach(() => { vi.useRealTimers(); });

describe('switching from speaking to typing', () => {
  it('moves what was heard into the typed draft', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    speech.recognizers[0].heard = 'I lead a data team';
    await act(() => result.current.releaseToTyping());
    expect(deps.mergeIntoDraft).toHaveBeenCalledWith('I lead a data team');
  });

  it('does not submit what was heard over the top of the switch', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    speech.recognizers[0].heard = 'half a thought';
    await act(() => result.current.releaseToTyping());
    expect(deps.submitAnswer).not.toHaveBeenCalled();
  });

  it('transcribes recorded audio the recognizer never turned into words', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    await act(() => result.current.releaseToTyping());
    expect(deps.mergeIntoDraft).toHaveBeenCalledWith('transcribed words');
  });

  it('says so when recorded audio could not be transcribed', async () => {
    speech.transcribe.mockResolvedValue(null);
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    await act(() => result.current.releaseToTyping());
    expect(deps.setErr).toHaveBeenCalledWith(expect.stringMatching(/could not turn what you said into text/));
  });
});

describe('switching from typing to speaking', () => {
  it('sends the typed words together with what is then said', async () => {
    // The first stretch was silence: its recording transcribes to nothing.
    speech.transcribe.mockResolvedValue(null);
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    await act(() => result.current.holdCapture());
    act(() => result.current.carryIn('Typed first part.'));
    await act(() => result.current.beginListening({ resume: true }));
    speech.recognizers[1].heard = 'then spoken.';
    act(() => result.current.doneAnswering());
    await flush();
    expect(deps.submitAnswer).toHaveBeenCalledWith('Typed first part. then spoken.');
  });

  it('keeps typed words carried before the turn opens', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    act(() => result.current.carryIn('Early notes.'));
    await act(() => result.current.beginListening());
    speech.recognizers[0].heard = 'and more';
    act(() => result.current.doneAnswering());
    await flush();
    expect(deps.submitAnswer).toHaveBeenCalledWith('Early notes. and more');
  });
});

describe('an answer interrupted by a check-in', () => {
  it('is still in progress while the interviewer checks in', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    speech.recognizers[0].heard = 'my first point';
    speech.nudge.mockImplementationOnce(() => new Promise(() => undefined));
    act(() => speech.recognizers[0].handlers.onSilence?.());
    await flush();
    expect(result.current.answerInProgress()).toBe(true);
  });

  it('keeps the words said before it when listening resumes', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    speech.recognizers[0].heard = 'my first point';
    act(() => speech.recognizers[0].handlers.onSilence?.());
    await flush();
    const latest = speech.recognizers[speech.recognizers.length - 1];
    latest.heard = 'and my second';
    act(() => result.current.doneAnswering());
    await flush();
    expect(deps.submitAnswer).toHaveBeenCalledWith('my first point and my second');
  });

  it('is no longer in progress once the next question arrives', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    act(() => result.current.endAnswer());
    expect(result.current.answerInProgress()).toBe(false);
  });
});

describe('opening the microphone', () => {
  it('keeps only one recognizer when listening starts twice at once', async () => {
    speech.holdStarts = true;
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.beginListening(); second = result.current.beginListening({ resume: true }); });
    await act(async () => { speech.pendingStarts.forEach((open) => open()); await first; await second; });
    expect(speech.recognizers).toHaveLength(1);
  });

  it('stops the recording that lost the race', async () => {
    speech.holdStarts = true;
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.beginListening(); second = result.current.beginListening({ resume: true }); });
    await act(async () => { speech.pendingStarts.forEach((open) => open()); await first; await second; });
    expect(speech.recordings.filter((r) => !r.stopped)).toHaveLength(1);
  });

  it('never leaves the microphone on when the room closes while it opens', async () => {
    speech.holdStarts = true;
    const deps = makeDeps();
    const { result, unmount } = renderHook(() => useVoiceAnswer(deps));
    let pending!: Promise<void>;
    act(() => { pending = result.current.beginListening(); });
    unmount();
    await act(async () => { speech.pendingStarts.forEach((open) => open()); await pending; });
    expect(speech.recordings.every((r) => r.stopped)).toBe(true);
  });

  it('does not start listening when the phase moved on while it opened', async () => {
    speech.holdStarts = true;
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    let pending!: Promise<void>;
    act(() => { pending = result.current.beginListening(); });
    deps.phaseRef.current = 'speaking';
    await act(async () => { speech.pendingStarts.forEach((open) => open()); await pending; });
    expect(speech.recognizers).toHaveLength(0);
  });
});

describe('when the microphone dies', () => {
  it('puts everything heard so far into the typed draft', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    await act(() => result.current.holdCapture());
    await act(() => result.current.beginListening({ resume: true }));
    speech.recognizers[0].heard = 'first';
    speech.recognizers[1].heard = 'second';
    // The first part was held with its words; the second is live when it dies.
    act(() => speech.recognizers[1].handlers.onDead?.('network'));
    await flush();
    expect(deps.mergeIntoDraft).toHaveBeenCalledWith(expect.stringContaining('second'));
  });

  it('stops the recording', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    act(() => speech.recognizers[0].handlers.onDead?.('network'));
    await flush();
    expect(speech.recordings.every((r) => r.stopped)).toBe(true);
  });

  it('tells the room the microphone is off', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    act(() => speech.recognizers[0].handlers.onDead?.('network'));
    await flush();
    expect(deps.onMicDead).toHaveBeenCalled();
  });
});

describe('leaving the room', () => {
  it('does not submit a partial answer from the aborted recognizer', async () => {
    const deps = makeDeps();
    const { result, unmount } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    speech.recognizers[0].heard = 'half an answer';
    unmount();
    await flush();
    expect(deps.submitAnswer).not.toHaveBeenCalled();
  });

  it('stops the recording', async () => {
    const deps = makeDeps();
    const { result, unmount } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    unmount();
    expect(speech.recordings.every((r) => r.stopped)).toBe(true);
  });
});

describe('a finished spoken answer', () => {
  it('transcribes an earlier part the recognizer missed and keeps it in order', async () => {
    speech.transcribe.mockResolvedValue('earlier words');
    const deps = makeDeps();
    const { result } = renderHook(() => useVoiceAnswer(deps));
    await act(() => result.current.beginListening());
    await act(() => result.current.holdCapture());
    await act(() => result.current.beginListening({ resume: true }));
    speech.recognizers[1].heard = 'later words';
    act(() => result.current.doneAnswering());
    await flush();
    expect(deps.submitAnswer).toHaveBeenCalledWith('earlier words later words');
  });
});
