// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

/**
 * The operator's queue with something actually waiting in it.
 *
 * The queue only ever survived review because every test it had saw an empty
 * list, so the row was never rendered. The response below is the one
 * `GET /api/admin/signups` really sends — the applicant's details nested under
 * `applicant` — and rendering it is the check that was missing: approval is the
 * only door into Questor, so a queue that falls to its error boundary the
 * moment someone knocks locks everyone out.
 */

const server = vi.hoisted(() => ({
  signups: [] as unknown[],
  error: null as null | { status: number },
}));

class FakeApiError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

vi.mock('../src/api/client', () => ({
  api: {
    get: () => (server.error ? Promise.reject(new FakeApiError(server.error.status)) : Promise.resolve({ signups: server.signups })),
    post: () => Promise.resolve({ recorded: true }),
  },
  ApiError: FakeApiError,
}));

const { SignupQueue } = await import('../src/pages/SignupQueue');

/** A PENDING request exactly as the endpoint returns it. */
function waiting(over: Record<string, unknown> = {}) {
  return {
    id: 'sr-1',
    name: 'Priya Sharma',
    email: 'priya@acme.com',
    mode: 'new-org',
    organisationName: 'Priya Labs',
    orgSlug: null,
    status: 'PENDING',
    expiresAt: '2026-09-30T08:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    createdTenantId: null,
    createdUserId: null,
    createdAt: '2026-09-23T08:00:00.000Z',
    applicant: { name: 'Priya Sharma', email: 'priya@acme.com', organisation: 'Priya Labs', mode: 'new-org' },
    ...over,
  };
}

beforeEach(() => {
  server.signups = [];
  server.error = null;
});

afterEach(cleanup);

describe('the account requests queue', () => {
  it('renders a waiting request instead of throwing', async () => {
    server.signups = [waiting()];

    render(createElement(SignupQueue));

    await waitFor(() => expect(screen.getByText('Priya Sharma')).toBeTruthy());
    expect(screen.getByText('Wants to start a new organisation called Priya Labs.')).toBeTruthy();
  });

  it('offers a decision on the row it drew', async () => {
    server.signups = [waiting()];

    render(createElement(SignupQueue));

    await waitFor(() => expect(screen.getByLabelText("Approve Priya Sharma's request")).toBeTruthy());
    expect(screen.getByLabelText("Decline Priya Sharma's request")).toBeTruthy();
  });

  it('says what a join request is asking for, by the organisation code', async () => {
    server.signups = [waiting({
      mode: 'join',
      organisationName: null,
      orgSlug: 'acme-hiring',
      applicant: { name: 'Priya Sharma', email: 'priya@gmail.com', organisation: 'acme-hiring', mode: 'join' },
    })];

    render(createElement(SignupQueue));

    await waitFor(() => expect(screen.getByText('Wants to join acme-hiring.')).toBeTruthy());
  });

  it('still draws the row when the applicant carries no organisation', async () => {
    server.signups = [waiting({ applicant: { name: 'Priya Sharma', email: 'priya@acme.com', mode: 'new-org' } })];

    render(createElement(SignupQueue));

    await waitFor(() => expect(screen.getByText('Wants to start a new organisation.')).toBeTruthy());
  });

  it('says the queue could not be read rather than that nobody is waiting', async () => {
    server.error = { status: 500 };

    render(createElement(SignupQueue));

    await waitFor(() => expect(screen.getByText(/could not be read/)).toBeTruthy());
  });
});
