// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVisualViewport } from '../src/components/room/useRoomServices';

/** The room fits the visible viewport, so a phone keyboard never hides the composer. */

function fakeViewport(height: number, offsetTop: number) {
  const listeners = new Set<() => void>();
  const vv = {
    height, offsetTop,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal('visualViewport', vv);
  return { vv, fire: () => listeners.forEach((fn) => fn()) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--room-vh');
  document.documentElement.style.removeProperty('--room-top');
  document.documentElement.removeAttribute('data-room-compact');
});

describe('useVisualViewport', () => {
  it('sizes the room to the visible height', () => {
    fakeViewport(500, 0);
    renderHook(() => useVisualViewport());
    expect(document.documentElement.style.getPropertyValue('--room-vh')).toBe('500px');
  });

  it('follows the keyboard opening', () => {
    const { vv, fire } = fakeViewport(800, 0);
    renderHook(() => useVisualViewport());
    act(() => { vv.height = 420; vv.offsetTop = 60; fire(); });
    expect(document.documentElement.style.getPropertyValue('--room-top')).toBe('60px');
  });

  it('marks the room compact when the keyboard leaves little height', () => {
    fakeViewport(420, 0);
    renderHook(() => useVisualViewport());
    expect(document.documentElement.hasAttribute('data-room-compact')).toBe(true);
  });

  it('is not compact at full height', () => {
    fakeViewport(800, 0);
    renderHook(() => useVisualViewport());
    expect(document.documentElement.hasAttribute('data-room-compact')).toBe(false);
  });

  it('lets go when the room closes', () => {
    fakeViewport(500, 0);
    const { unmount } = renderHook(() => useVisualViewport());
    unmount();
    expect(document.documentElement.style.getPropertyValue('--room-vh')).toBe('');
  });
});
