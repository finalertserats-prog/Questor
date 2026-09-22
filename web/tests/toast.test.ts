// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '../src/components/Toast';
import { TOAST_LEAVE_MS, TOAST_MS, type ToastOptions } from '../src/components/toastModel';

/**
 * The shared toast: a polite live region, gone after about four seconds,
 * held while the pointer or focus is on it, with an optional Undo.
 */

function Trigger({ message, options }: { message: string; options?: ToastOptions }) {
  const toast = useToast();
  useEffect(() => { toast.show(message, options); }, [toast, message, options]);
  return null;
}

const mount = (message = 'Invitation sent to Priya', options?: ToastOptions) =>
  render(createElement(ToastProvider, null, createElement(Trigger, { message, options })));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
// The fade is scheduled once the countdown ends, so the two run as two steps.
const runOut = () => { advance(TOAST_MS + 10); advance(TOAST_LEAVE_MS + 10); };

describe('toasts', () => {
  it('appear inside a polite live region', () => {
    mount();
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('show the message', () => {
    mount();
    expect(screen.getByRole('status').textContent).toContain('Invitation sent to Priya');
  });

  it('are gone after about four seconds', () => {
    mount();
    runOut();
    expect(screen.queryByText('Invitation sent to Priya')).toBeNull();
  });

  it('are still there just before four seconds', () => {
    mount();
    advance(TOAST_MS - 100);
    expect(screen.queryByText('Invitation sent to Priya')).not.toBeNull();
  });

  it('stay while the pointer is on them', () => {
    mount();
    fireEvent.mouseEnter(screen.getByText('Invitation sent to Priya').closest('.toast')!);
    advance(TOAST_MS * 3);
    expect(screen.queryByText('Invitation sent to Priya')).not.toBeNull();
  });

  it('stay while focus is inside them', () => {
    mount();
    fireEvent.focus(screen.getByRole('button', { name: 'Dismiss' }));
    advance(TOAST_MS * 3);
    expect(screen.queryByText('Invitation sent to Priya')).not.toBeNull();
  });

  it('carry on counting once the pointer leaves', () => {
    mount();
    const toast = screen.getByText('Invitation sent to Priya').closest('.toast')!;
    fireEvent.mouseEnter(toast);
    advance(10_000);
    fireEvent.mouseLeave(toast);
    runOut();
    expect(screen.queryByText('Invitation sent to Priya')).toBeNull();
  });

  it('run the Undo and close when it is pressed', () => {
    const run = vi.fn();
    mount('Moved to Gold', { undo: { run } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect({ ran: run.mock.calls.length, shown: screen.queryByText('Moved to Gold') !== null }).toEqual({ ran: 1, shown: false });
  });

  it('have no Undo unless one is given', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('can be dismissed', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    advance(TOAST_LEAVE_MS + 10);
    expect(screen.queryByText('Invitation sent to Priya')).toBeNull();
  });

  it('keep a test id the old banner carried', () => {
    mount('Decision recorded', { testId: 'decision-notice' });
    expect(screen.getByTestId('decision-notice').textContent).toContain('Decision recorded');
  });
});
