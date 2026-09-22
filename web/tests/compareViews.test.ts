// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * What the role page's comparison actually shows.
 *
 * The rules being held to here are the ones a screenshot cannot prove on its
 * own: a competency with no evidence says so in words rather than showing a
 * zero, a candidate the blind-review policy withholds keeps their name and
 * loses their levels, and a figure produced against a different scorecard is
 * marked rather than lined up silently beside the others.
 */

const responses = vi.hoisted(() => ({ byPath: new Map<string, unknown>() }));

vi.mock('../src/api/client', () => ({
  api: {
    get: (path: string) => {
      const found = [...responses.byPath.entries()].find(([prefix]) => path.startsWith(prefix));
      return found ? Promise.resolve(found[1]) : Promise.reject(new Error(`No stub for ${path}`));
    },
    post: () => Promise.resolve({ candidateIds: [], max: 4 }),
    del: () => Promise.resolve({ candidateIds: [], max: 4 }),
  },
  ApiError: class ApiError extends Error {},
}));

const { SkillsGrid } = await import('../src/components/compare/SkillsGrid');
const { SideBySide } = await import('../src/components/compare/SideBySide');
const { CandidatesTable } = await import('../src/components/compare/CandidatesTable');

const SORT = { key: 'recency', dir: 'desc' } as const;

const COMPETENCIES = [
  { id: 'delivery', name: 'Delivery', category: 'behavioral', requiredLevel: 3, targetLevel: 4, weight: 0.5 },
  { id: 'stakeholders', name: 'Stakeholder handling', category: 'behavioral', requiredLevel: 3, targetLevel: 4, weight: 0.5 },
];

function stub(path: string, body: unknown) {
  responses.byPath.set(path, body);
}

function mount(element: ReturnType<typeof createElement>) {
  return render(createElement(MemoryRouter, null, element));
}

afterEach(() => {
  cleanup();
  responses.byPath.clear();
});

describe('the skills grid', () => {
  function gridWith(rows: unknown[]) {
    stub('/roles/r1/candidates/grid', {
      competencies: COMPETENCIES, rows, scorecardVersion: 3,
      meta: { total: rows.length, page: 1, pageSize: 25 },
    });
    return mount(createElement(SkillsGrid, { roleId: 'r1', sort: SORT }));
  }

  it('shows each candidate as a row', async () => {
    gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', levelSource: 'ai',
      cells: { delivery: { kind: 'level', level: 4 }, stakeholders: { kind: 'level', level: 2 } }, comparability: [],
    }]);
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  });

  it('names every competency as a column', async () => {
    gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', levelSource: 'ai',
      cells: { delivery: { kind: 'level', level: 4 }, stakeholders: { kind: 'level', level: 2 } }, comparability: [],
    }]);
    await waitFor(() => expect(screen.queryByText('Stakeholder handling')).toBeTruthy());
  });

  it('says there is no evidence in words', async () => {
    gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', levelSource: 'ai',
      cells: { delivery: { kind: 'no_evidence' }, stakeholders: { kind: 'level', level: 3 } }, comparability: [],
    }]);
    expect(await screen.findByText('No evidence')).toBeTruthy();
  });

  it('never shows a zero where a level would be', async () => {
    const { container } = gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', levelSource: 'ai',
      cells: { delivery: { kind: 'no_evidence' }, stakeholders: { kind: 'not_assessed' } }, comparability: [],
    }]);
    await screen.findByText('Ada Lovelace');
    expect([...container.querySelectorAll('.cmp-level')].map((n) => n.textContent)).toEqual([]);
  });

  it('says a competency was never put to this candidate', async () => {
    gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', levelSource: 'ai',
      cells: { delivery: { kind: 'level', level: 3 }, stakeholders: { kind: 'not_assessed' } }, comparability: [],
    }]);
    expect(await screen.findByText('Not assessed')).toBeTruthy();
  });

  it('marks a level at or above what the role asks for with weight, not a fill', async () => {
    const { container } = gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', levelSource: 'ai',
      cells: { delivery: { kind: 'level', level: 5 }, stakeholders: { kind: 'level', level: 1 } }, comparability: [],
    }]);
    await screen.findByText('Ada Lovelace');
    expect([...container.querySelectorAll('.cmp-cell')].map((n) => n.className))
      .toEqual(['cmp-cell is-above', 'cmp-cell is-below']);
  });

  it('says whose levels a row is showing', async () => {
    gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', levelSource: 'human',
      cells: { delivery: { kind: 'level', level: 4 } }, comparability: [],
    }]);
    expect(await screen.findByText(/reviewer.s levels/)).toBeTruthy();
  });

  it('keeps a withheld candidate on screen but without their levels', async () => {
    gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', blindReviewPending: true,
      levelSource: null, cells: {}, comparability: [],
    }]);
    expect(await screen.findByText(/Record your own verdict first/)).toBeTruthy();
  });

  it('offers the withheld candidate’s reviewer a way to record their verdict', async () => {
    gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', blindReviewPending: true,
      levelSource: null, cells: {}, comparability: [],
    }]);
    expect(await screen.findByText('Give your review')).toBeTruthy();
  });

  it('marks a candidate scored on a different scorecard version', async () => {
    gridWith([{
      candidateId: 'c1', fullName: 'Ada Lovelace', assessmentId: 'a1', levelSource: 'ai',
      cells: { delivery: { kind: 'level', level: 4 } },
      comparability: [{ kind: 'scorecard_version', text: 'Scored on a different scorecard version (v2, against v3 here).' }],
    }]);
    expect(await screen.findByText('different scorecard version')).toBeTruthy();
  });

  it('says so plainly when the role has no scored competencies', async () => {
    stub('/roles/r1/candidates/grid', { competencies: [], rows: [], scorecardVersion: 1, meta: { total: 0, page: 1, pageSize: 25 } });
    mount(createElement(SkillsGrid, { roleId: 'r1', sort: SORT }));
    expect(await screen.findByText('This role has no scored competencies')).toBeTruthy();
  });
});

describe('the candidates table', () => {
  function tableWith(candidates: unknown[], shortlist: string[] = []) {
    stub('/roles/r1/candidates?', { candidates, meta: { total: candidates.length, page: 1, pageSize: 25 }, sort: SORT, shortlistedTotal: 0 });
    return mount(createElement(CandidatesTable, {
      roleId: 'r1', sort: SORT, onSort: () => undefined,
      shortlist: new Set(shortlist), shortlistFull: false, onShortlist: () => undefined,
    }));
  }

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'c1', fullName: 'Ada Lovelace', email: 'ada@example.com',
    stage: { key: 'silver', label: 'Silver', order: 3, decision: null },
    latestInterview: { id: 'i1', state: 'REVIEW_READY' }, assessmentId: 'a1',
    recommendation: 'PROCEED', humanRecommendation: null, overallScore: 88,
    scorecardVersion: 3, competenciesGraded: 6, durationMinutes: 45,
    lastMovedAt: '2026-09-20T10:00:00Z', shortlisted: false, comparability: [], ...over,
  });

  it('lists the applicants', async () => {
    tableWith([row()]);
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  });

  it('shows the stage they have reached', async () => {
    tableWith([row()]);
    expect(await screen.findByText('Silver')).toBeTruthy();
  });

  it('shows the score against its scale', async () => {
    tableWith([row()]);
    expect(await screen.findByText('88/100')).toBeTruthy();
  });

  it('offers a shortlist tick per candidate', async () => {
    tableWith([row()]);
    expect(await screen.findByLabelText('Shortlist Ada Lovelace')).toBeTruthy();
  });

  it('says the verdict is held back rather than showing a dash', async () => {
    tableWith([row({ recommendation: undefined, humanRecommendation: undefined, overallScore: undefined, blindReviewPending: true })]);
    expect((await screen.findAllByText('Your review first')).length).toBeGreaterThan(0);
  });

  it('says plainly when nobody has applied yet', async () => {
    tableWith([]);
    expect(await screen.findByText('No candidates on this role yet')).toBeTruthy();
  });
});

describe('the side-by-side', () => {
  const compared = (over: Record<string, unknown> = {}) => ({
    id: 'c1', fullName: 'Ada Lovelace', email: 'ada@example.com',
    stage: { key: 'silver', label: 'Silver', decision: null },
    latestInterview: { id: 'i1', state: 'REVIEW_READY' }, assessmentId: 'a1',
    recommendation: 'PROCEED', humanRecommendation: null, overallScore: 88, levelSource: 'ai',
    competencies: [
      { id: 'delivery', cell: { kind: 'level', level: 4 }, rationale: 'Owned the migration.', evidence: [{ quote: 'I led the rollback', turnId: 't1', startMs: 1000 }] },
      { id: 'stakeholders', cell: { kind: 'no_evidence' }, rationale: '', evidence: [] },
    ],
    nextRoundAt: null, nextRoundTimeZone: null, comparability: [], ...over,
  });

  function sideBySideWith(candidates: unknown[]) {
    stub('/roles/r1/candidates/comparison', {
      competencies: COMPETENCIES, candidates, scorecardVersion: 3, availabilityRecorded: false,
    });
    return mount(createElement(SideBySide, { roleId: 'r1', candidateIds: ['c1', 'c2'], onClose: () => undefined }));
  }

  it('gives each candidate a column', async () => {
    sideBySideWith([compared(), compared({ id: 'c2', fullName: 'Grace Hopper' })]);
    expect(await screen.findByText('Grace Hopper')).toBeTruthy();
  });

  it('carries the evidence quote the level was drawn from', async () => {
    sideBySideWith([compared(), compared({ id: 'c2', fullName: 'Grace Hopper' })]);
    expect((await screen.findAllByText('I led the rollback')).length).toBeGreaterThan(0);
  });

  it('links a quote to that candidate’s own assessment', async () => {
    const { container } = sideBySideWith([compared(), compared({ id: 'c2', fullName: 'Grace Hopper', assessmentId: 'a2' })]);
    await screen.findByText('Grace Hopper');
    const links = [...container.querySelectorAll('.cmp-quote a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('/assessments/a2#turn-t1');
  });

  it('says where a competency has no evidence rather than scoring it nothing', async () => {
    sideBySideWith([compared(), compared({ id: 'c2', fullName: 'Grace Hopper' })]);
    expect((await screen.findAllByText('No evidence')).length).toBeGreaterThan(0);
  });

  it('says plainly that availability is not recorded', async () => {
    sideBySideWith([compared(), compared({ id: 'c2', fullName: 'Grace Hopper' })]);
    expect(await screen.findByText(/does not record a candidate.s notice period/)).toBeTruthy();
  });

  it('withholds a candidate whose verdict this reviewer owes', async () => {
    sideBySideWith([
      compared(),
      compared({ id: 'c2', fullName: 'Grace Hopper', blindReviewPending: true, recommendation: undefined, overallScore: undefined, competencies: [], levelSource: null }),
    ]);
    expect(await screen.findByText(/Record your own verdict for this candidate first/)).toBeTruthy();
  });

  it('says nothing is booked when no interview is scheduled', async () => {
    sideBySideWith([compared(), compared({ id: 'c2', fullName: 'Grace Hopper' })]);
    expect((await screen.findAllByText('Nothing booked')).length).toBe(2);
  });
});
