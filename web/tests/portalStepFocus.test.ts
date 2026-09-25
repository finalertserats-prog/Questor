// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Where focus lands when the portal swaps one step for the next.
 *
 * The journey replaces its own form in place: consent becomes the one-time
 * code, the code becomes the audio check. Each swap takes away the control the
 * candidate had just used, and focus falls back to the page body — which a
 * screen reader announces as nothing at all. Somebody who has just been told
 * their code was accepted then has to go looking for the screen that says so.
 */

const server = vi.hoisted(() => ({ info: null as unknown, posts: [] as string[] }));

vi.mock('../src/api/client', () => ({
  api: {
    get: () => Promise.resolve(server.info),
    post: (path: string) => {
      server.posts.push(path);
      return Promise.resolve({});
    },
  },
  ApiError: class ApiError extends Error { status = 0; },
}));

vi.mock('../src/speech', () => ({
  sttSupported: () => true,
  ttsSupported: () => true,
  speak: (_text: string, done?: () => void) => done?.(),
}));

const { Portal } = await import('../src/pages/Portal');

function portalInfo(over: Record<string, unknown> = {}) {
  return {
    candidateName: 'Priya Sharma',
    roleTitle: 'Senior Backend Engineer',
    state: 'INVITED',
    durationMinutes: 30,
    aiDisclosure: 'Your interviewer today is Maya, an AI interviewer from Questor.',
    recordingRequested: false,
    privacy: 'Your responses are transcribed and reviewed by our hiring team.',
    accommodationsEnabled: false,
    proctoringEnabled: false,
    consented: false,
    speech: { stt: { provider: 'webspeech', mode: 'browser', configured: true }, tts: { provider: 'webspeech' } },
    persona: { name: 'Maya' },
    ...over,
  };
}

function show() {
  return render(createElement(
    MemoryRouter,
    { initialEntries: ['/portal/abc'] },
    createElement(Routes, null, createElement(Route, { path: '/portal/:token', element: createElement(Portal) })),
  ));
}

beforeEach(() => {
  server.info = portalInfo();
  server.posts = [];
});

afterEach(cleanup);

describe('moving on to the audio check', () => {
  it('moves focus to the heading of the step that replaced the form', async () => {
    show();

    (await screen.findByRole('button', { name: /Continue/ })).click();
    const agree = await screen.findByLabelText(/I understand this first round/);
    agree.click();
    (await screen.findByRole('button', { name: /I consent/ })).click();

    const heading = await screen.findByRole('heading', { name: 'Quick audio check' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('keeps that heading out of the tab order once it has been read', async () => {
    show();

    (await screen.findByRole('button', { name: /Continue/ })).click();
    (await screen.findByLabelText(/I understand this first round/)).click();
    (await screen.findByRole('button', { name: /I consent/ })).click();

    const heading = await screen.findByRole('heading', { name: 'Quick audio check' });
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('does not steal focus on the first screen, where nothing has changed yet', async () => {
    show();

    await screen.findByRole('button', { name: /Continue/ });
    expect(document.activeElement).toBe(document.body);
  });
});
