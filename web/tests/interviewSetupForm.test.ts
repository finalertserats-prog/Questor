// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * "Set up interview" on the candidate page, as a person meets it.
 *
 * The reviewer's point, which the owner took: the interviewer's name led this
 * form while the settings that decide what the interview actually is were
 * either an unlabelled field or nowhere on the page. A name picker carries
 * almost no signal — the five differ in name and voice only — and length, what
 * gets asked, tone and language carry nearly all of it.
 *
 * So these are tests about hierarchy and words, not about behaviour: what is
 * named, what is explained, and what comes before what. Nothing the form SENDS
 * changed, and `sends exactly what it sent before` is here to keep it that way.
 */

const ROLE_RESP = {
  role: { id: 'role1', title: 'Data Analyst', level: 'mid' },
  scorecards: [
    { version: 3, status: 'draft', profile: { competencies: [{ name: 'Still being drafted', classification: 'essential' }] } },
    {
      version: 2,
      status: 'approved',
      profile: {
        roleContext: '', outcomes: [], responsibilities: [],
        competencies: [
          { name: 'SQL', classification: 'essential' },
          { name: 'Stakeholder management', classification: 'preferred' },
          { name: 'Interviewer notes', classification: 'non_scoring' },
          { name: 'An old one', classification: 'essential', retired: true },
        ],
      },
    },
  ],
};

const CANDIDATE_RESP = {
  candidate: { id: 'cand1', fullName: 'Priya Raman', email: 'priya@example.com', phone: '', roleId: 'role1' },
  profile: null, fit: null, rawText: '', interviews: [],
};

const post = vi.fn(async () => ({ session: { id: 'sess1', state: 'created', provider: 'hosted' } }));

/**
 * One fake for every read the page fans out. Anything unrecognised rejects
 * rather than resolving to a shape nobody wrote: a silent `{}` is how a test
 * comes to assert against a page rendered from nothing.
 */
const get = vi.fn(async (path: string) => {
  if (path.startsWith('/candidates/cand1/profile-analysis')) return { analysis: null };
  if (path.startsWith('/candidates/cand1')) return CANDIDATE_RESP;
  if (path.startsWith('/roles/role1')) return ROLE_RESP;
  if (path.startsWith('/interviews')) return { sessions: [], meta: { total: 0 } };
  if (path.startsWith('/pipelines')) return { pipelines: [] };
  if (path.startsWith('/interviewers')) {
    return { interviewers: [{ id: 'maya', name: 'Maya', avatarUrl: null, sortOrder: 2 }] };
  }
  throw new Error(`unstubbed read: ${path}`);
});

vi.mock('../src/api/client', () => ({
  api: { get: (path: string) => get(path), post: (path: string, body: unknown) => post(path, body) },
  ApiError: class ApiError extends Error {},
  getToken: () => null,
  setToken: () => {},
}));

vi.mock('../src/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'hr@example.com', role: 'hr', capabilities: ['interview:create'] } }),
}));

vi.mock('../src/components/useOrgTimeZone', () => ({ useOrgTimeZone: () => 'Asia/Kolkata' }));

// The board, the pipeline and the reuse card each fan out reads of their own
// and none of them is what this file is about.
vi.mock('../src/components/CandidateJourneyBoard', () => ({ CandidateJourneyBoard: () => null }));
vi.mock('../src/components/PipelinePanel', () => ({ PipelinePanel: () => null }));
vi.mock('../src/components/SetUpForAnotherRole', () => ({ SetUpForAnotherRole: () => null }));
vi.mock('../src/components/EraseCandidateCard', () => ({ EraseCandidateCard: () => null }));
vi.mock('../src/components/CandidateAtsLink', () => ({ CandidateAtsLink: () => null }));

const { CandidateDetail } = await import('../src/pages/CandidateDetail');
const { ToastProvider } = await import('../src/components/Toast');

/** The card, once the candidate and their role have loaded. */
async function setupCard(): Promise<HTMLElement> {
  render(createElement(
    MemoryRouter,
    { initialEntries: ['/candidates/cand1?tab=journey'] },
    createElement(
      ToastProvider,
      null,
      createElement(Routes, null, createElement(Route, { path: '/candidates/:id', element: createElement(CandidateDetail) })),
    ),
  ));
  const heading = await screen.findByRole('heading', { name: 'Set up interview' }, { timeout: 5000 });
  const card = heading.closest('.card');
  if (!(card instanceof HTMLElement)) throw new Error('the setup card has no card element');
  return card;
}

beforeEach(() => { get.mockClear(); post.mockClear(); });
afterEach(() => cleanup());

describe('the settings that shape the interview', () => {
  it('groups them under a heading that says what they are for', async () => {
    const card = await setupCard();
    expect(within(card).getByRole('group', { name: /What shapes this interview/i })).toBeTruthy();
  });

  it('names the length as a plain word, not "Duration (minutes)"', async () => {
    const card = await setupCard();
    expect(within(card).getByLabelText('Length')).toBeTruthy();
  });

  it('starts on the default length, visibly', async () => {
    const card = await setupCard();
    expect((within(card).getByLabelText('Length') as HTMLInputElement).value).toBe('45');
  });

  it('starts on the default tone, visibly', async () => {
    const card = await setupCard();
    expect((within(card).getByLabelText('Tone') as HTMLSelectElement).value).toBe('warm');
  });

  /**
   * The whole point of the change: a setting nobody can see the effect of is a
   * setting nobody touches. Each control says, in one line, what it changes —
   * and says it through aria-describedby, so it is read out with the field
   * rather than sitting near it on screen only.
   */
  it('explains what the length changes, to the field itself', async () => {
    const card = await setupCard();
    const help = within(card).getByLabelText('Length').getAttribute('aria-describedby');
    expect(card.querySelector(`#${help}`)?.textContent).toMatch(/how much time/i);
  });

  it('explains what the tone changes, to the field itself', async () => {
    const card = await setupCard();
    const help = within(card).getByLabelText('Tone').getAttribute('aria-describedby');
    expect(card.querySelector(`#${help}`)?.textContent).toMatch(/how the interviewer speaks/i);
  });

  it('promises that tone does not change the questions or the marking', async () => {
    const card = await setupCard();
    expect(card.textContent).toMatch(/questions and the way answers are judged are the same/i);
  });

  it('offers every tone the server accepts', async () => {
    const card = await setupCard();
    const options = within(card).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['warm', 'neutral', 'formal']);
  });
});

describe('what the interview will ask about', () => {
  it('names the competencies instead of leaving them to be discovered afterwards', async () => {
    const card = await setupCard();
    await waitFor(() => expect(within(card).getByText('SQL')).toBeTruthy());
    expect(within(card).getByText('Stakeholder management')).toBeTruthy();
  });

  it('leaves out what no interview would ask about', async () => {
    const card = await setupCard();
    await waitFor(() => expect(within(card).getByText('SQL')).toBeTruthy());
    expect(within(card).queryByText('Interviewer notes')).toBe(null);
    expect(within(card).queryByText('An old one')).toBe(null);
  });

  // The journey board shows the newest scorecard; this form has to show the
  // newest APPROVED one, because that is the version the server plans from.
  it('shows the approved scorecard, not a draft somebody is midway through', async () => {
    const card = await setupCard();
    await waitFor(() => expect(within(card).getByText('SQL')).toBeTruthy());
    expect(within(card).queryByText('Still being drafted')).toBe(null);
  });

  it('says where to change them, since they are not changed here', async () => {
    const card = await setupCard();
    expect(card.textContent).toMatch(/change what is asked on the role/i);
  });

  it('states the language rather than hiding it', async () => {
    const card = await setupCard();
    expect(card.textContent).toMatch(/English/);
    expect(card.textContent).toMatch(/only one whose wording has been reviewed/i);
  });
});

describe('the interviewer picker', () => {
  it('is still there, and still defaults to Random', async () => {
    const card = await setupCard();
    const random = await within(card).findByRole('radio', { name: 'Random — Recommended' });
    expect((random as HTMLInputElement).checked).toBe(true);
  });

  /**
   * Secondary, not hidden. A disclosure would have made the five names
   * unreachable without a click, and "pick a different voice" is a reasonable
   * thing to want to do without hunting for it.
   */
  it('comes after the settings that decide what the interview is', async () => {
    const card = await setupCard();
    const group = within(card).getByRole('group', { name: /What shapes this interview/i });
    const picker = card.querySelector('[data-testid="interviewer-select"]');
    expect(picker).toBeTruthy();
    expect(group.compareDocumentPosition(picker!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says the five differ in name and voice only', async () => {
    const card = await setupCard();
    const picker = card.querySelector('[data-testid="interviewer-select"]');
    expect(picker?.textContent).toMatch(/name and voice only/i);
  });

  /**
   * Never a hint that one of them is warmer, tougher or better at anything.
   * The five are the same interview in a different voice, and copy implying
   * otherwise would have HR picking a name in order to pick a style.
   */
  it('never suggests a name changes the style or the difficulty', async () => {
    const card = await setupCard();
    const picker = card.querySelector('[data-testid="interviewer-select"]');
    expect(picker?.textContent).not.toMatch(/warmer|tougher|harder|strict|friendly|formal style|experienced/i);
  });
});

describe('what the form still does', () => {
  it('keeps the button HR looks for', async () => {
    const card = await setupCard();
    expect(within(card).getByRole('button', { name: /Approve & create interview/ })).toBeTruthy();
  });

  // Layout, hierarchy and copy only. If this test has to change, the change
  // was not the one that was asked for.
  it('sends exactly what it sent before', async () => {
    const card = await setupCard();
    (within(card).getByRole('button', { name: /Approve & create interview/ }) as HTMLButtonElement).click();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]).toEqual(['/interviews', {
      candidateId: 'cand1',
      durationMinutes: 45,
      language: 'en',
      modules: ['warmup', 'technical', 'behavioral', 'wrapup'],
      interviewer: 'random',
      persona: { tone: 'warm' },
      provider: 'hosted',
      recordingRequested: false,
      humanReviewRequired: true,
      approve: true,
    }]);
  });
});
