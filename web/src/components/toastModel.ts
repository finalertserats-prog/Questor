/**
 * Rules for toasts, kept free of React so they can be unit tested (see
 * web/tests/toastModel.test.ts).
 *
 * A toast says "done, nothing more to do": sent, saved, copied, moved. It
 * fades by itself. Anything still waiting on someone is a banner, which stays
 * until it is handled — so a toast is never the only way to do something, and
 * its Undo is a convenience rather than the route.
 */

import type { ReactNode } from 'react';

/** Long enough to read a short sentence; hovering or focusing pauses it. */
export const TOAST_MS = 4000;
/** The fade-out, kept in step with the .toast transition in styles/lists.css. */
export const TOAST_LEAVE_MS = 220;
/** More than this and older ones make way: a stack of confirmations is noise. */
export const MAX_TOASTS = 3;

export interface ToastUndo {
  readonly label?: string;
  readonly run: () => void;
}

export interface ToastOptions {
  readonly undo?: ToastUndo;
  /** A link or control that follows on from the message, e.g. "Open". */
  readonly action?: ReactNode;
  /** A stable hook for tests that looked for the old banner. */
  readonly testId?: string;
}

export interface ToastItem extends ToastOptions {
  readonly id: number;
  readonly message: ReactNode;
}

export function addToast(list: readonly ToastItem[], item: ToastItem): readonly ToastItem[] {
  return [...list, item].slice(-MAX_TOASTS);
}

export function removeToast(list: readonly ToastItem[], id: number): readonly ToastItem[] {
  return list.filter((t) => t.id !== id);
}

/**
 * A countdown that can be paused. Time spent paused (pointer over it, focus in
 * it) does not count, so someone reading or reaching for Undo is not cut off.
 */
export interface Countdown {
  readonly remainingMs: number;
  /** When it last started running; null while paused. */
  readonly runningSince: number | null;
}

export function startCountdown(now: number, durationMs = TOAST_MS): Countdown {
  return { remainingMs: durationMs, runningSince: now };
}

export function pauseCountdown(c: Countdown, now: number): Countdown {
  if (c.runningSince === null) return c;
  return { remainingMs: Math.max(0, c.remainingMs - (now - c.runningSince)), runningSince: null };
}

export function resumeCountdown(c: Countdown, now: number): Countdown {
  return c.runningSince === null ? { ...c, runningSince: now } : c;
}

/** Milliseconds until it runs out, if it is running; null while paused. */
export function msUntilDone(c: Countdown, now: number): number | null {
  if (c.runningSince === null) return null;
  return Math.max(0, c.remainingMs - (now - c.runningSince));
}
