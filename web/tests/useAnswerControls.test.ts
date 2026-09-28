// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAnswerControls, type AnswerControlDeps } from '../src/components/room/useAnswerControls';
import type { RoomPhase } from '../src/components/room/roomConversationModel';

/** The candidate's own controls: switching how they answer, pausing, repeating. */

function makeDeps(over: { phase?: RoomPhase; textMode?: boolean; typed?: string; inProgress?: boolean } = {}) {
  const textModeRef = { current: over.textMode ?? false };
  const voice = {
    releaseToTyping: vi.fn(async () => undefined),
    carryIn: vi.fn(),
    holdCapture: vi.fn(async () => undefined),
    beginListening: vi.fn(async () => undefined),
    answerInProgress: vi.fn(() => over.inProgress ?? false),
    turnClosedRef: { current: false },
  };
  const answerMode = {
    textModeRef,
    setTextMode: vi.fn((on: boolean) => { textModeRef.current = on; }),
    setCodeMode: vi.fn(),
    choose: vi.fn(),
  };
  const deps = {
    voice,
    answerMode,
    typed: over.typed ?? '',
    setTyped: vi.fn(),
    setInterim: vi.fn(),
    setPaused: vi.fn(),
    pausedRef: { current: false },
    phaseRef: { current: over.phase ?? 'listening' },
    setPhase: vi.fn(),
    speakUnavailableRef: { current: null },
    replayQuestion: vi.fn(),
  };
  return deps;
}

const render = (deps: ReturnType<typeof makeDeps>) =>
  renderHook(() => useAnswerControls(deps as unknown as AnswerControlDeps));

describe('switching from typing to speaking', () => {
  it('carries the typed words into the spoken answer', async () => {
    const deps = makeDeps({ textMode: true, typed: 'My typed start.' });
    const { result } = render(deps);
    await act(() => result.current.selectMode('speak'));
    expect(deps.voice.carryIn).toHaveBeenCalledWith('My typed start.');
  });

  it('clears the box only because the words moved into the answer', async () => {
    const deps = makeDeps({ textMode: true, typed: 'My typed start.' });
    const { result } = render(deps);
    await act(() => result.current.selectMode('speak'));
    expect(deps.setTyped).toHaveBeenCalledWith('');
  });
});

describe('switching from speaking to typing', () => {
  it('hands what was said to the typed draft rather than discarding it', async () => {
    const deps = makeDeps({ textMode: false, typed: 'already typed' });
    const { result } = render(deps);
    await act(() => result.current.selectMode('type'));
    expect(deps.voice.releaseToTyping).toHaveBeenCalled();
  });

  it('never replaces text already in the box', async () => {
    const deps = makeDeps({ textMode: false, typed: 'already typed' });
    const { result } = render(deps);
    await act(() => result.current.selectMode('code'));
    expect(deps.setTyped).not.toHaveBeenCalled();
  });
});

describe('repeating the question', () => {
  it('continues the answer in progress when asked during a check-in', async () => {
    const deps = makeDeps({ phase: 'speaking', inProgress: true });
    const { result } = render(deps);
    await act(() => result.current.repeat());
    expect(deps.replayQuestion).toHaveBeenCalledWith(true);
  });

  it('starts the answer afresh when asked before answering began', async () => {
    const deps = makeDeps({ phase: 'speaking', inProgress: false });
    const { result } = render(deps);
    await act(() => result.current.repeat());
    expect(deps.replayQuestion).toHaveBeenCalledWith(false);
  });

  it('holds what was said so far before the question plays again', async () => {
    const deps = makeDeps({ phase: 'listening', inProgress: true });
    const { result } = render(deps);
    await act(() => result.current.repeat());
    expect(deps.voice.holdCapture).toHaveBeenCalled();
  });
});

describe('taking a moment', () => {
  it('holds a spoken answer while paused', async () => {
    const deps = makeDeps({ phase: 'listening' });
    const { result } = render(deps);
    await act(() => result.current.pause());
    expect(deps.voice.holdCapture).toHaveBeenCalled();
  });

  it('resumes the same answer', async () => {
    const deps = makeDeps({ phase: 'listening' });
    const { result } = render(deps);
    act(() => result.current.resume());
    expect(deps.voice.beginListening).toHaveBeenCalledWith({ resume: true });
  });
});
