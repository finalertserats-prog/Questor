// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';

/**
 * How often the console asks the server how it is.
 *
 * The sweep found a cancelled GET /api/admin/health in the network panel on
 * every single load of /admin and /admin/health — the request the panel makes
 * on mount, thrown away by whatever asked next. The endpoint answers in 84ms;
 * nothing here is impatient enough for a fresher answer to be worth cancelling
 * one that is already on its way.
 */

const server = vi.hoisted(() => ({
  calls: 0,
  aborted: 0,
  release: [] as (() => void)[],
}));

vi.mock('../src/api/client', () => ({
  api: {
    get: (_path: string, opts?: { signal?: AbortSignal }) => {
      server.calls += 1;
      return new Promise((resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => { server.aborted += 1; reject(new Error('aborted')); });
        server.release.push(() => resolve({ status: 'ok', checkedAt: new Date().toISOString(), sections: [] }));
      });
    },
  },
  ApiError: class extends Error { status = 0; },
}));

const { SystemHealthPanel } = await import('../src/components/SystemHealthPanel');

beforeEach(() => {
  server.calls = 0;
  server.aborted = 0;
  server.release = [];
});

afterEach(cleanup);

describe('the system health request', () => {
  it('asks once on mount', async () => {
    render(createElement(SystemHealthPanel));

    await waitFor(() => expect(server.calls).toBe(1));
  });

  it('does not cancel and re-ask when the tab becomes visible again', async () => {
    render(createElement(SystemHealthPanel));
    await waitFor(() => expect(server.calls).toBe(1));

    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    expect({ calls: server.calls, aborted: server.aborted }).toEqual({ calls: 1, aborted: 0 });
  });

  it('asks again once the first answer has arrived', async () => {
    render(createElement(SystemHealthPanel));
    await waitFor(() => expect(server.calls).toBe(1));
    await act(async () => { server.release.forEach((go) => go()); });

    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    expect({ calls: server.calls, aborted: server.aborted }).toEqual({ calls: 2, aborted: 0 });
  });

  it('abandons the request when the console is left', async () => {
    const view = render(createElement(SystemHealthPanel));
    await waitFor(() => expect(server.calls).toBe(1));

    view.unmount();

    expect(server.aborted).toBe(1);
  });
});
