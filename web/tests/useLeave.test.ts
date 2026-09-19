// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/** The Leave action: available only while there is an interview to leave, and safe to fail. */

const http = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return { ...real, api: { ...real.api, post: http.post } };
});

const { ApiError } = await import('../src/api/client');
const { useLeave } = await import('../src/components/room/useLeave');

function makeDeps(over: { done?: boolean; textMode?: boolean } = {}) {
  return {
    token: 't',
    currentTurnDone: () => over.done ?? false,
    textModeRef: { current: over.textMode ?? false },
    pausedRef: { current: false },
    holdCapture: vi.fn(async () => undefined),
    beginListening: vi.fn(async () => undefined),
    stopSpeech: vi.fn(),
    setPhase: vi.fn(),
    setErr: vi.fn(),
    showFinished: vi.fn(),
    onLeft: vi.fn(),
  };
}

beforeEach(() => { http.post.mockReset(); });

describe('Leave', () => {
  it('is not offered once the interviewer has signed off', () => {
    const { result } = renderHook(() => useLeave(makeDeps({ done: true })));
    expect(result.current.available(true)).toBe(false);
  });

  it('is offered while the interview is live', () => {
    const { result } = renderHook(() => useLeave(makeDeps()));
    expect(result.current.available(true)).toBe(true);
  });

  it('does nothing when pressed after the sign-off', async () => {
    const { result } = renderHook(() => useLeave(makeDeps({ done: true })));
    await act(() => result.current.leave());
    expect(http.post).not.toHaveBeenCalled();
  });

  it('is sent as the Leave action, not as an answer to the question', async () => {
    http.post.mockResolvedValue({ turn: { turnId: 'x', text: 'bye', done: true, withdrawn: true } });
    const { result } = renderHook(() => useLeave(makeDeps()));
    await act(() => result.current.leave());
    expect(http.post).toHaveBeenCalledWith('/portal/t/turn', expect.objectContaining({ leaving: true, inReplyTo: undefined }));
  });

  it('hands the sign-off to the room', async () => {
    const turn = { turnId: 'x', text: 'bye', done: true, withdrawn: true };
    http.post.mockResolvedValue({ turn });
    const deps = makeDeps();
    const { result } = renderHook(() => useLeave(deps));
    await act(() => result.current.leave());
    expect(deps.onLeft).toHaveBeenCalledWith(turn);
  });

  it('says plainly that leaving failed', async () => {
    http.post.mockRejectedValue(new ApiError(500, 'Server error'));
    const deps = makeDeps();
    const { result } = renderHook(() => useLeave(deps));
    await act(() => result.current.leave());
    expect(deps.setErr).toHaveBeenCalledWith("We couldn't end the interview — try again.");
  });

  it('carries on the answer in progress when leaving failed', async () => {
    http.post.mockRejectedValue(new ApiError(500, 'Server error'));
    const deps = makeDeps();
    const { result } = renderHook(() => useLeave(deps));
    await act(() => result.current.leave());
    expect(deps.beginListening).toHaveBeenCalledWith({ resume: true });
  });

  it('shows the finished screen when the interview had already ended', async () => {
    http.post.mockRejectedValue(new ApiError(410, 'This interview has already been completed.'));
    const deps = makeDeps();
    const { result } = renderHook(() => useLeave(deps));
    await act(() => result.current.leave());
    expect(deps.showFinished).toHaveBeenCalled();
  });
});
