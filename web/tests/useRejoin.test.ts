// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/** Rejoin recoveries: nothing the candidate wrote is lost, and a finished interview says so. */

const http = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return { ...real, api: { ...real.api, post: http.post } };
});

const { ApiError } = await import('../src/api/client');
const { useRejoin } = await import('../src/components/room/useRejoin');

function makeDeps() {
  return {
    token: 't',
    openOn: vi.fn(),
    setAwaitingReply: vi.fn(),
    showQuestion: vi.fn(),
    sayAndListen: vi.fn(),
    beginListening: vi.fn(),
    thinking: vi.fn(),
    showFinished: vi.fn(),
    keepAnswer: vi.fn(),
    setErr: vi.fn(),
    reopenTurn: vi.fn(),
    stopAnswering: vi.fn(),
    receiveTurn: vi.fn(),
    currentTurnId: () => 't1',
  };
}

const question = { turnId: 't2', text: 'Next question?', done: false };

beforeEach(() => { http.post.mockReset(); });

describe('an answer to a question the interview has moved past', () => {
  it('keeps what the candidate wrote', async () => {
    http.post.mockResolvedValue({ turn: question, resumed: true, history: [], awaitingReply: false });
    const deps = makeDeps();
    const { result } = renderHook(() => useRejoin(deps));
    await act(() => result.current.catchUpAfterStale('my answer'));
    expect(deps.keepAnswer).toHaveBeenCalledWith('my answer');
  });

  it('puts the current question up', async () => {
    http.post.mockResolvedValue({ turn: question, resumed: true, history: [], awaitingReply: false });
    const deps = makeDeps();
    const { result } = renderHook(() => useRejoin(deps));
    await act(() => result.current.catchUpAfterStale('my answer'));
    expect(deps.sayAndListen).toHaveBeenCalledWith(question, 'Welcome back.');
  });

  it('shows the finished screen when the interview has ended', async () => {
    http.post.mockRejectedValue(new ApiError(410, 'This interview has already been completed.'));
    const deps = makeDeps();
    const { result } = renderHook(() => useRejoin(deps));
    await act(() => result.current.catchUpAfterStale('my answer'));
    expect(deps.showFinished).toHaveBeenCalled();
  });
});

describe('Continue', () => {
  it('asks for the reply and speaks a new question', async () => {
    http.post.mockResolvedValue({ turn: question });
    const deps = makeDeps();
    const { result } = renderHook(() => useRejoin(deps));
    await act(() => result.current.continueInterview());
    expect(deps.receiveTurn).toHaveBeenCalledWith(question);
  });

  it('listens again when it fails, so the candidate can add to their answer', async () => {
    http.post.mockRejectedValue(new ApiError(500, 'Server error'));
    const deps = makeDeps();
    const { result } = renderHook(() => useRejoin(deps));
    await act(() => result.current.continueInterview());
    expect(deps.beginListening).toHaveBeenCalled();
  });
});
