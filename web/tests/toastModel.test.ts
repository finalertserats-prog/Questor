import { describe, expect, it } from 'vitest';
import {
  addToast,
  MAX_TOASTS,
  msUntilDone,
  pauseCountdown,
  removeToast,
  resumeCountdown,
  startCountdown,
  TOAST_MS,
  type ToastItem,
} from '../src/components/toastModel';

const item = (id: number): ToastItem => ({ id, message: `Toast ${id}` });

describe('toast list', () => {
  it('adds to the end', () => {
    expect(addToast([item(1)], item(2)).map((t) => t.id)).toEqual([1, 2]);
  });

  it('keeps only the newest few', () => {
    const list = [1, 2, 3, 4].reduce<readonly ToastItem[]>((acc, id) => addToast(acc, item(id)), []);
    expect(list.map((t) => t.id)).toEqual([2, 3, 4].slice(-MAX_TOASTS));
  });

  it('does not change the list it was given', () => {
    const list = [item(1)];
    addToast(list, item(2));
    expect(list).toHaveLength(1);
  });

  it('removes one by id', () => {
    expect(removeToast([item(1), item(2)], 1).map((t) => t.id)).toEqual([2]);
  });
});

describe('toast countdown', () => {
  it('runs for about four seconds', () => {
    expect(TOAST_MS).toBe(4000);
  });

  it('counts down while running', () => {
    expect(msUntilDone(startCountdown(1000), 2500)).toBe(TOAST_MS - 1500);
  });

  it('has no deadline while paused', () => {
    expect(msUntilDone(pauseCountdown(startCountdown(0), 1000), 5000)).toBeNull();
  });

  it('does not count the time spent paused', () => {
    const paused = pauseCountdown(startCountdown(0), 1000);
    expect(msUntilDone(resumeCountdown(paused, 60_000), 60_000)).toBe(TOAST_MS - 1000);
  });

  it('pausing twice changes nothing', () => {
    const once = pauseCountdown(startCountdown(0), 1000);
    expect(pauseCountdown(once, 3000)).toEqual(once);
  });

  it('never goes below zero', () => {
    expect(msUntilDone(startCountdown(0), 99_000)).toBe(0);
  });
});
