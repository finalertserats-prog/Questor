// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoomTopBar, type RoomTopBarProps } from '../src/components/room/RoomTopBar';

/**
 * On a phone the participants rail hides its "What's captured" details, and a
 * keyboard-open (compact) room hides the rail altogether. The only in-room
 * statement that the interviewer is an AI was then a tooltip on the capture
 * pill, which a touch screen never shows. The top bar carries the same facts
 * behind a control a finger or a keyboard can open.
 */

const AI_FACT = 'Maya is an AI interviewer. A person on the hiring team reviews the interview.';

const props = (over: Partial<RoomTopBarProps> = {}): RoomTopBarProps => ({
  roleTitle: 'Data Engineer', durationMinutes: 30, startedAt: 0, finished: false, question: null,
  capture: { mode: 'transcribing', stt: { provider: 'browser', mode: 'browser', configured: false }, aiFact: AI_FACT },
  showActions: true, paused: false, pauseAvailable: true, leaveAvailable: true,
  onPause: () => undefined, onLeave: () => undefined,
  ...over,
});

const control = () => screen.getByRole('button', { name: "What's captured" });

afterEach(cleanup);

describe('RoomTopBar "What\'s captured"', () => {
  it('starts closed', () => {
    render(createElement(RoomTopBar, props()));
    expect(control().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on a tap and says the interviewer is an AI', () => {
    render(createElement(RoomTopBar, props()));
    fireEvent.click(control());
    expect(screen.getByText(AI_FACT)).toBeTruthy();
  });

  it('reports itself open', () => {
    render(createElement(RoomTopBar, props()));
    fireEvent.click(control());
    expect(control().getAttribute('aria-expanded')).toBe('true');
  });

  it('points at the details it opens', () => {
    render(createElement(RoomTopBar, props()));
    fireEvent.click(control());
    const id = control().getAttribute('aria-controls') ?? '';
    expect(document.getElementById(id)?.textContent).toContain(AI_FACT);
  });

  it('closes on Escape', () => {
    render(createElement(RoomTopBar, props()));
    fireEvent.click(control());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(AI_FACT)).toBeNull();
  });

  it('hands focus back to the control when Escape closes it', () => {
    render(createElement(RoomTopBar, props()));
    act(() => { control().focus(); });
    fireEvent.click(control());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(control());
  });

  it('closes on a second tap', () => {
    render(createElement(RoomTopBar, props()));
    fireEvent.click(control());
    fireEvent.click(control());
    expect(screen.queryByText(AI_FACT)).toBeNull();
  });

  it('describes voice capture the way the rail does', () => {
    render(createElement(RoomTopBar, props()));
    fireEvent.click(control());
    expect(screen.getByText('Your voice is turned into text while you speak. No audio is kept.')).toBeTruthy();
  });

  it('shows the privacy content it is handed in place of its own', () => {
    render(createElement(RoomTopBar, props({ capture: null, privacy: createElement('p', null, 'Handed facts') })));
    fireEvent.click(control());
    expect(screen.getByText('Handed facts')).toBeTruthy();
  });

  it('is absent when there are no facts to show', () => {
    render(createElement(RoomTopBar, props({ capture: null })));
    expect(screen.queryByRole('button', { name: "What's captured" })).toBeNull();
  });
});

describe('room.css for the top-bar facts', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'room.css'), 'utf8');

  it('hides the control on a wide screen, where the rail shows the facts', () => {
    expect(css).toMatch(/^\.room-facts\s*\{[^}]*display:\s*none/m);
  });

  it('shows it at phone widths', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 820px)'));
    expect(phone).toMatch(/\.room-facts\s*\{[^}]*display:\s*(inline-)?block/);
  });

  it('shows it in a compact room', () => {
    expect(css).toMatch(/:root\[data-room-compact\] \.room-facts\s*\{[^}]*display:\s*(inline-)?block/);
  });

  it('keeps the code-editor nudge in a compact room', () => {
    const hidden = css.match(/((?::root\[data-room-compact\][^,{]*,\s*)*:root\[data-room-compact\][^,{]*)\{\s*display:\s*none;?\s*\}/g) ?? [];
    expect(hidden.join('\n')).not.toContain('.room-nudge');
  });

  it('holds the compact nudge to one line', () => {
    expect(css).toMatch(/:root\[data-room-compact\] \.room-nudge\s*\{[^}]*white-space:\s*nowrap/);
  });
});
