// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer, READ_BACK_SETTLE_MS, type ComposerProps } from '../src/components/room/Composer';

/**
 * The composer through a screen reader and a keyboard. The question it is
 * built around: how does a candidate who cannot see the screen confirm that
 * what they just said is what we heard?
 */

const props = (over: Partial<ComposerProps> = {}): ComposerProps => ({
  mode: 'speak',
  speakUnavailable: null,
  phase: 'listening',
  paused: false,
  interviewerName: 'Maya',
  capturing: true,
  interim: '',
  typed: '',
  canSend: false,
  currentQuestion: 'Tell me about a migration you led.',
  repeatAvailable: true,
  nudge: null,
  getCandidateLevel: () => 0,
  onTypedChange: () => undefined,
  onSelectMode: () => undefined,
  onSend: () => undefined,
  onDoneSpeaking: () => undefined,
  onRepeat: () => undefined,
  onResume: () => undefined,
  ...over,
});

const heard = () => screen.getByRole('region', { name: 'What we heard you say' });
const readBack = () => screen.getByRole('button', { name: /read back/i });

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the candidate own words, for a candidate who cannot see them', () => {
  it('puts what was heard in a region a screen reader can go to on request', () => {
    render(createElement(Composer, props({ interim: 'We ran both side by side' })));
    expect(heard().textContent).toContain('We ran both side by side');
  });

  it('does not read every partial result out loud by default', () => {
    render(createElement(Composer, props({ interim: 'We ran both' })));
    expect(heard().getAttribute('aria-live')).toBeNull();
  });

  it('offers a read-back the candidate can switch on', () => {
    render(createElement(Composer, props()));
    expect(readBack().getAttribute('aria-pressed')).toBe('false');
  });

  it('remembers that it is on', () => {
    render(createElement(Composer, props()));
    fireEvent.click(readBack());
    expect(readBack().getAttribute('aria-pressed')).toBe('true');
  });

  it('says nothing while the words are still arriving', () => {
    vi.useFakeTimers();
    const { rerender } = render(createElement(Composer, props()));
    fireEvent.click(readBack());
    rerender(createElement(Composer, props({ interim: 'We ran' })));
    act(() => { vi.advanceTimersByTime(READ_BACK_SETTLE_MS - 50); });
    rerender(createElement(Composer, props({ interim: 'We ran both side by side' })));
    act(() => { vi.advanceTimersByTime(READ_BACK_SETTLE_MS - 50); });
    expect(screen.getByTestId('room-read-back').textContent).toBe('');
  });

  it('reads the whole phrase back once it has settled', () => {
    vi.useFakeTimers();
    const { rerender } = render(createElement(Composer, props()));
    fireEvent.click(readBack());
    rerender(createElement(Composer, props({ interim: 'We ran both side by side' })));
    act(() => { vi.advanceTimersByTime(READ_BACK_SETTLE_MS + 50); });
    expect(screen.getByTestId('room-read-back').textContent).toBe('We ran both side by side');
  });

  it('waits its turn rather than cutting the interviewer off', () => {
    render(createElement(Composer, props()));
    fireEvent.click(readBack());
    expect(screen.getByTestId('room-read-back').getAttribute('aria-live')).toBe('polite');
  });
});

describe('where the keyboard lands', () => {
  it('takes focus when it replaces the Join button', () => {
    render(createElement(Composer, props()));
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Answer this question' }));
  });

  it('moves focus to what was heard when the candidate says they are done', () => {
    render(createElement(Composer, props({ interim: 'and that is how we did it' })));
    fireEvent.click(screen.getByRole('button', { name: 'Done answering' }));
    expect(document.activeElement).toBe(heard());
  });

  it('keeps focus in the composer after Send empties the box and disables it', () => {
    render(createElement(Composer, props({ mode: 'type', typed: 'That covers it.', canSend: true })));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Your answer' }));
  });

  it('moves focus to the resume button when the pause button disappears', () => {
    const { rerender } = render(createElement(Composer, props()));
    rerender(createElement(Composer, props({ paused: true })));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /ready/i }));
  });

  it('brings focus back into the composer when the pause ends', () => {
    const { rerender } = render(createElement(Composer, props({ paused: true })));
    rerender(createElement(Composer, props({ paused: false })));
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Answer this question' }));
  });
});

describe('every control says what it is', () => {
  it('names the microphone by what pressing it does', () => {
    render(createElement(Composer, props({ capturing: true })));
    expect(screen.getByRole('button', { name: 'Done answering' })).toBeTruthy();
  });

  it('explains the microphone when speaking is not available', () => {
    render(createElement(Composer, props({ speakUnavailable: 'Speaking is not available.', mode: 'type' })));
    expect(screen.getByRole('button', { name: /Speaking unavailable/ })).toBeTruthy();
  });

  it('names the way of answering that is chosen', () => {
    render(createElement(Composer, props()));
    expect(screen.getByRole('button', { name: 'Speak' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('names the typed answer box', () => {
    render(createElement(Composer, props({ mode: 'type' })));
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeTruthy();
  });

  it('keeps Send reachable and named', () => {
    render(createElement(Composer, props({ mode: 'type', typed: 'hello', canSend: true })));
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false);
  });
});
