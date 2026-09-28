// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * Where adding a candidate leaves you.
 *
 * The only control that starts an interview lives in the candidate's
 * **journey** tab. After adding a candidate the page used to navigate to
 * `/candidates/:id` with no query string, which opens on the profile tab, and
 * the journey tabpanel — holding the "Set up interview" card — renders
 * `hidden`. HR reached the last step of their first journey, saw a
 * finished-looking profile, and stopped.
 *
 * This asserts the destination as the page itself produces it, not the helper
 * that builds the path: removing `?tab=journey` from either navigation fails
 * here.
 */

const server = vi.hoisted(() => ({
  roles: [] as unknown[],
  people: [] as unknown[],
  posted: [] as { path: string; body: unknown }[],
}));

vi.mock('../src/api/client', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path.startsWith('/roles')) return { roles: server.roles };
      if (path.startsWith('/candidates/search')) return { people: server.people };
      return {};
    }),
    post: vi.fn(async (path: string, body: unknown) => {
      server.posted.push({ path, body });
      if (path === '/candidates') return { candidate: { id: 'cand-new' } };
      if (path.endsWith('/apply')) return { candidate: { id: 'cand-reused' } };
      return {};
    }),
    postForm: vi.fn(async () => ({})),
  },
  ApiError: class ApiError extends Error { status = 500; },
}));

vi.mock('../src/auth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'admin', name: 'Admin' } }) }));
vi.mock('../src/components/Toast', () => ({ useToast: () => ({ show: vi.fn() }) }));

const { CandidateCreate } = await import('../src/pages/CandidateCreate');

function LocationProbe() {
  const loc = useLocation();
  return h('p', { 'data-testid': 'where' }, `${loc.pathname}${loc.search}`);
}

function renderPage() {
  render(h(
    MemoryRouter,
    { initialEntries: ['/candidates/new'] },
    h(Routes, null,
      h(Route, { path: '/candidates/new', element: h(CandidateCreate) }),
      h(Route, { path: '*', element: h(LocationProbe) }),
    ),
  ));
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  server.posted.length = 0;
  server.people = [];
  server.roles = [{
    id: 'role-1', title: 'Data Engineer', level: 'mid', status: 'approved',
    latestScorecard: { id: 'sc-1', version: 1, status: 'approved' }, candidates: 0, updatedAt: new Date().toISOString(),
  }];
});

afterEach(cleanup);

describe('after adding a candidate', () => {
  it('lands on the journey tab, where the interview is set up', async () => {
    renderPage();
    await screen.findByLabelText('Full name');

    type('Full name', 'Meera Iyer');
    type('Email', 'meera@example.com');
    type('Or paste resume text', 'Five years of pipelines.');
    fireEvent.submit(screen.getByLabelText('Full name').closest('form')!);

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/candidates/cand-new?tab=journey'));
  });

  it('lands on the journey tab for a person set up on a second role, too', async () => {
    // The reuse path has its own navigation, and the same thing is true of it:
    // an application with no interview is not finished.
    server.people = [{
      candidateId: 'cand-old', fullName: 'Meera Iyer', email: 'meera@example.com', phone: '',
      hasResume: true, roles: [{ roleId: 'role-other', candidateId: 'cand-old', title: 'Analyst', status: 'active' }],
    }];
    renderPage();
    const name = await screen.findByLabelText('Full name');

    const form = name.closest('form')!;
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'Meera' } });
    const option = await screen.findByRole('option', { name: /Meera Iyer/ });
    fireEvent.click(option);
    fireEvent.submit(form);

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/candidates/cand-reused?tab=journey'));
  });
});
