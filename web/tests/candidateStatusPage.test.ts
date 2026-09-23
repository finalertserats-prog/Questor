// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The candidate's status page as it actually renders.
 *
 * What is being held to here is what a screenshot cannot prove: that the page
 * says the same kind thing whatever state the interview ended in, that it never
 * prints anything assessed, that a link the server no longer knows closes
 * cleanly instead of erroring, and that "this employer doesn't send written
 * feedback" is said plainly rather than replaced by a promise.
 */

const server = vi.hoisted(() => ({
  status: null as unknown,
  statusError: null as null | { status: number },
  letter: null as unknown,
  posted: [] as string[],
  postFails: false,
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
    get: (path: string) => {
      if (path.endsWith('/status')) {
        return server.statusError
          ? Promise.reject(new FakeApiError(server.statusError.status))
          : Promise.resolve(server.status);
      }
      if (path.endsWith('/feedback')) {
        return server.letter ? Promise.resolve(server.letter) : Promise.reject(new FakeApiError(404));
      }
      return Promise.reject(new Error(`No stub for ${path}`));
    },
    post: (path: string) => {
      server.posted.push(path);
      return server.postFails ? Promise.reject(new Error('no')) : Promise.resolve({ requested: true });
    },
  },
  ApiError: FakeApiError,
}));

const { CandidateStatus } = await import('../src/pages/CandidateStatus');

function statusView(over: Record<string, unknown> = {}) {
  return {
    candidateName: 'Priya Sharma',
    roleTitle: 'Senior Backend Engineer',
    organisation: 'Northwind Labs',
    interviewer: 'Maya',
    outcome: 'completed',
    timeZone: 'Asia/Kolkata',
    appliedAt: '2026-09-14T06:00:00Z',
    appliedKind: 'application',
    interviewAt: '2026-09-22T12:38:00Z',
    interviewMinutes: 38,
    readByTeamAt: null,
    nextRound: null,
    decisionSharedAt: null,
    feedback: { outlook: 'expected', dueAt: null, sentAt: null },
    talkToAPerson: { requested: false, requestedAt: null },
    retainUntil: '2027-03-21T12:38:00Z',
    ...over,
  };
}

function show() {
  return render(createElement(MemoryRouter, null, createElement(CandidateStatus, { token: 'abc' })));
}

beforeEach(() => {
  server.status = statusView();
  server.statusError = null;
  server.letter = null;
  server.posted = [];
  server.postFails = false;
});

afterEach(cleanup);

describe('the page a finished interview leads to', () => {
  it('thanks the candidate by name and names who they talked to', async () => {
    show();

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('Priya');
    expect(screen.getByText(/You talked with Maya for 38 minutes/)).toBeTruthy();
  });

  it('says the link cannot start another interview', async () => {
    show();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText(/can’t start another interview/)).toBeTruthy();
  });

  it('lays the journey out as a list, with a heading above it', async () => {
    show();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('heading', { name: 'Where you are' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('puts the whole page inside a main landmark', async () => {
    show();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('links what is kept about them, and for how long', async () => {
    show();

    const link = await screen.findByRole('link', { name: /What is kept about you/ });
    expect(link.getAttribute('href')).toBeTruthy();
  });
});

describe('what the page never shows a candidate', () => {
  it('prints no score, verdict, recommendation or competency anywhere', async () => {
    server.status = statusView({ readByTeamAt: '2026-09-24T06:00:00Z' });
    const { container } = show();

    await screen.findByRole('heading', { level: 1 });
    expect(container.textContent).not.toMatch(/PROCEED|CONSIDER|DO_NOT_PROGRESS/);
    expect(container.textContent).not.toMatch(/score|verdict|competenc|recommendation/i);
  });
});

describe('written feedback', () => {
  it('shows the letter once it has been sent', async () => {
    server.status = statusView({ feedback: { outlook: 'arrived', dueAt: null, sentAt: '2026-09-24T06:00:00Z' } });
    server.letter = { approvedText: 'What came through clearly: your reasoning.', sentAt: '2026-09-24T06:00:00Z' };
    show();

    await waitFor(() => expect(screen.getByTestId('cstatus-letter').textContent).toContain('your reasoning'));
    expect(screen.getByRole('heading', { name: 'Feedback from your conversation' })).toBeTruthy();
  });

  it('says who wrote it and who decides, beside the words', async () => {
    server.status = statusView({ feedback: { outlook: 'arrived', dueAt: null, sentAt: '2026-09-24T06:00:00Z' } });
    server.letter = { approvedText: 'Some words.', sentAt: '2026-09-24T06:00:00Z' };
    show();

    await waitFor(() => expect(screen.getByTestId('cstatus-letter')).toBeTruthy());
    expect(screen.getByText(/Decisions are always made by people/)).toBeTruthy();
  });

  it('keeps the waiting wording while the letter has not loaded', async () => {
    server.status = statusView({ feedback: { outlook: 'arrived', dueAt: null, sentAt: '2026-09-24T06:00:00Z' } });
    server.letter = null;
    show();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByTestId('cstatus-feedback-note')).toBeTruthy();
  });

  it('says plainly when the employer does not send written feedback', async () => {
    server.status = statusView({ feedback: { outlook: 'not_offered', dueAt: null, sentAt: null } });
    show();

    await waitFor(() => expect(screen.getByTestId('cstatus-feedback-note').textContent)
      .toMatch(/Northwind Labs does not send written feedback/));
  });

  it('says a person is still looking, with no date, when it is held', async () => {
    server.status = statusView({ feedback: { outlook: 'with_a_person', dueAt: null, sentAt: null } });
    show();

    await waitFor(() => expect(screen.getByTestId('cstatus-feedback-note').textContent)
      .toMatch(/no date to give you yet/));
  });
});

describe('asking to speak to a person', () => {
  it('records the request and confirms it', async () => {
    const { container } = show();

    const button = await screen.findByRole('button', { name: /speak to someone/ });
    button.click();

    await waitFor(() => expect(screen.getByTestId('cstatus-talk-recorded')).toBeTruthy());
    expect(server.posted).toEqual(['/portal/abc/talk-to-a-person']);
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows the request already on file without asking again', async () => {
    server.status = statusView({ talkToAPerson: { requested: true, requestedAt: '2026-09-24T06:00:00Z' } });
    show();

    await waitFor(() => expect(screen.getByTestId('cstatus-talk-recorded')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /speak to someone/ })).toBeNull();
  });

  it('says it did not go through, rather than pretending it did', async () => {
    server.postFails = true;
    show();

    (await screen.findByRole('button', { name: /speak to someone/ })).click();

    await waitFor(() => expect(screen.getByText(/could not record that just now/)).toBeTruthy());
  });
});

describe('a link that no longer resolves', () => {
  it('closes cleanly for an erased candidate rather than showing an error', async () => {
    server.statusError = { status: 404 };
    const { container } = show();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('no longer active');
    expect(container.textContent).not.toMatch(/HTTP 404|undefined|error/i);
  });

  it('says an expired link has expired, and where to go instead', async () => {
    server.statusError = { status: 410 };
    show();

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('expired');
  });

  it('reads as the old "not open" card when the link is still an invitation', async () => {
    server.statusError = { status: 409 };
    show();

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('not open right now');
  });

  it('owns a server failure as ours', async () => {
    server.statusError = { status: 500 };
    show();

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('could not load');
  });
});

describe('an interview that did not finish', () => {
  it('never thanks someone for a good conversation they withdrew from', async () => {
    server.status = statusView({ outcome: 'withdrawn', feedback: { outlook: 'none', dueAt: null, sentAt: null } });
    const { container } = show();

    await screen.findByRole('heading', { level: 1 });
    expect(container.textContent).not.toMatch(/good conversation/);
    expect(screen.getByText(/does not count against you/)).toBeTruthy();
  });

  it('still offers a way to reach a person', async () => {
    server.status = statusView({ outcome: 'withdrawn', feedback: { outlook: 'none', dueAt: null, sentAt: null } });
    show();

    expect(await screen.findByRole('button', { name: /speak to someone/ })).toBeTruthy();
  });
});
