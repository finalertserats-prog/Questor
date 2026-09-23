// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The room, driven the way a candidate drives it, with only the live regions
 * under the microscope.
 *
 * The owner's rule: announce what makes no sound, and nothing else. A blind
 * candidate HEARS the interviewer — so the question, the voice ring and the
 * turn-taking never reach a live region, however useful they look on screen.
 */

const QUESTION = 'Tell me about a migration you led.';
const SIGN_OFF = "That's everything — thank you.";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return { ...real, api: { ...real.api, get: http.get, post: http.post } };
});

const voice = vi.hoisted(() => {
  const state = { listener: null as ((e: unknown) => void) | null, audible: true, utterance: 0, meter: null as unknown };
  return {
    state,
    onSpeechActivity: (listener: ((e: unknown) => void) | null) => { state.listener = listener; },
    speakTurn: async (o: { text: string; onDone?: () => void }) => {
      if (state.audible) {
        state.utterance += 1;
        state.listener?.({ type: 'start', id: state.utterance, text: o.text, audio: null });
        state.listener?.({ type: 'end', id: state.utterance });
      }
      o.onDone?.();
    },
  };
});

vi.mock('../src/speech', () => ({
  speakTurn: voice.speakTurn,
  onSpeechActivity: voice.onSpeechActivity,
  stopAllSpeech: () => undefined,
  stopSpeaking: () => undefined,
  speak: (_text: string, done?: () => void) => done?.(),
  createMicMeter: async () => voice.state.meter,
  createRecognizer: () => null,
  startRecording: async () => null,
  transcribeOnServer: async () => null,
  speakNudge: async () => '',
  // Typing is the simplest honest room to drive: no recognizer to fake.
  sttSupported: () => false,
  ttsSupported: () => true,
}));

const { InterviewRoom } = await import('../src/pages/InterviewRoom');

const portal = (over: Record<string, unknown> = {}) => ({
  candidateName: 'Rita Banerjee',
  roleTitle: 'Data Engineer',
  durationMinutes: 30,
  persona: { name: 'Maya', interviewerId: 'maya', voiceHint: 'female:1' },
  recordingConsented: false,
  speech: { stt: { provider: 'browser', mode: 'browser', configured: false } },
  proctoringEnabled: false,
  feedbackOptIn: { offered: false, choice: null },
  ...over,
});

const opening = { turn: { turnId: 't1', text: QUESTION, done: false } };
const signOff = { turn: { turnId: 't2', text: SIGN_OFF, done: true } };

/** Everything a screen reader would have read out, from every live region on the page. */
const announced = () => [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')]
  .map((n) => n.textContent ?? '').join(' ');
const politely = () => screen.getAllByRole('status').map((n) => n.textContent).join(' ').trim();
const urgently = () => screen.queryAllByRole('alert').map((n) => n.textContent).join(' ').trim();

async function openRoom(info = portal()) {
  http.get.mockResolvedValue(info);
  http.post.mockResolvedValue(opening);
  render(createElement(
    MemoryRouter,
    { initialEntries: ['/room/tok'] },
    createElement(Routes, null, createElement(Route, { path: '/room/:token', element: createElement(InterviewRoom) })),
  ));
  await act(async () => { await Promise.resolve(); });
}

async function join() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Join interview/i })); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  voice.state.audible = true;
  voice.state.meter = { level: () => 0, stop: () => undefined };
});

afterEach(cleanup);

describe('what a blind candidate can already hear', () => {
  it('never announces the question the interviewer is saying', async () => {
    await openRoom();
    await join();
    expect(announced()).not.toContain(QUESTION);
  });

  it('never announces that the interviewer is speaking', async () => {
    await openRoom();
    await join();
    expect(announced().toLowerCase()).not.toContain('speaking');
  });

  it('still shows the question in the transcript, to be read on request', async () => {
    await openRoom();
    await join();
    expect(screen.getByRole('list', { name: 'Conversation so far' }).textContent).toContain(QUESTION);
  });

  it('never announces the interviewer name on its own', async () => {
    await openRoom();
    await join();
    expect(announced()).not.toContain('Maya:');
  });
});

describe('a question nothing said out loud', () => {
  it('gives the candidate the words, because there was no sound to hear', async () => {
    voice.state.audible = false;
    await openRoom();
    await join();
    expect(politely()).toContain(`Maya: ${QUESTION}`);
  });

  it('does not interrupt with it', async () => {
    voice.state.audible = false;
    await openRoom();
    await join();
    expect(urgently()).toBe('');
  });
});

describe('the room confirms it heard them', () => {
  it('says so when an answer goes in', async () => {
    await openRoom();
    await join();
    http.post.mockResolvedValue({ turn: { turnId: 't2', text: 'And after that?', done: false } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'We ran both side by side.' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(politely()).toContain('Got it');
  });
});

describe('a microphone that never opened', () => {
  it('interrupts, because the candidate has to do something about it', async () => {
    voice.state.meter = null;
    await openRoom(portal({ recordingConsented: true }));
    await join();
    expect(urgently()).toContain('microphone');
  });

  it('offers the keyboard rather than leaving them stuck', async () => {
    voice.state.meter = null;
    await openRoom(portal({ recordingConsented: true }));
    await join();
    expect(urgently()).toContain('Type');
  });
});

describe('the end of the interview', () => {
  it('says what happens now, which no sound conveys', async () => {
    await openRoom();
    await join();
    http.post.mockResolvedValue(signOff);
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'That covers it.' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(politely()).toContain('The interview has ended');
  });

  it('moves focus to the ending, not to a button that has gone', async () => {
    await openRoom();
    await join();
    http.post.mockResolvedValue(signOff);
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'That covers it.' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(document.activeElement?.textContent).toContain("That's everything");
  });
});

describe('a connection that comes and goes', () => {
  it('interrupts when it drops, because talking on is pointless', async () => {
    await openRoom();
    await join();
    await act(async () => { window.dispatchEvent(new Event('offline')); });
    expect(urgently()).toContain('offline');
  });

  it('waits its turn to say it is back', async () => {
    await openRoom();
    await join();
    await act(async () => { window.dispatchEvent(new Event('offline')); });
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(politely()).toContain('back online');
  });

  it('does not repeat itself when the browser fires the same event twice', async () => {
    await openRoom();
    await join();
    await act(async () => { window.dispatchEvent(new Event('offline')); });
    const once = urgently();
    await act(async () => { window.dispatchEvent(new Event('offline')); });
    expect(urgently()).toBe(once);
  });
});
