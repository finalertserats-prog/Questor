import { describe, expect, it } from 'vitest';
import {
  bulkOutcome, confidenceLabel, confidencePercent, decisionErrorMessage, DEFAULT_CATALOG_REVIEW_FILTERS, draftFrom, editPatch, familiesFor,
  filtersToQuery, hasActiveFilters, kindLabel, paginationLabel, placementLabel, pruneSelection, runStatusLine, runTotals, selectablePendingIds,
  runErrorText, runNowDisabled, sourceLinks, titleProblem, toggleAll, toggleSelection, validateEdit,
  type CatalogProposalView, type CatalogRunView, type EditOptions,
} from '../src/components/catalogReviewModel';
import { proposalStatus, refreshRunStatus } from '../src/components/statusModel';

function proposalView(overrides: Partial<CatalogProposalView> = {}): CatalogProposalView {
  return {
    id: 'p1', kind: 'new_role', status: 'pending', title: 'Agent Reliability Engineer', summary: '', confidence: 0.7,
    domain: { id: 'd1', name: 'Technology' }, family: { id: 'f1', name: 'Engineering' }, targetRole: null,
    sources: [], reviewerNote: '', createdAt: '2026-09-19T10:00:00.000Z', ...overrides,
  };
}

const options: EditOptions = {
  domains: [
    { id: 'd1', name: 'Technology', families: [{ id: 'f1', name: 'Engineering' }] },
    { id: 'd2', name: 'Healthcare', families: [{ id: 'f2', name: 'Care' }] },
  ],
};

function run(overrides: Partial<CatalogRunView> = {}): CatalogRunView {
  const source = { fetched: 0, matchedExisting: 0, proposed: 0, skipped: 0, errors: [] as string[] };
  return {
    id: 'r1', status: 'completed', trigger: 'schedule', triggeredBy: null, startedAt: '2026-09-19T10:00:00.000Z', finishedAt: '2026-09-19T10:05:00.000Z',
    stats: { onet: { ...source, fetched: 10, proposed: 3, skipped: 2 }, esco: { ...source, fetched: 5, proposed: 1, errors: ['esco down'] }, web: { ...source, skippedReason: 'no_openai_key' } },
    llmCalls: 2, researchCalls: 0, error: '', proposals: 4, ...overrides,
  };
}

describe('filters', () => {
  it('start on pending proposals', () => {
    expect(DEFAULT_CATALOG_REVIEW_FILTERS.status).toBe('pending');
  });

  it('become a query with only the chosen values, a page and a limit', () => {
    expect(filtersToQuery({ ...DEFAULT_CATALOG_REVIEW_FILTERS, source: 'web', q: '  agent ' }, 2, 25)).toBe('status=pending&source=web&q=agent&page=2&limit=25');
  });

  it('leave out every empty value', () => {
    expect(filtersToQuery({ status: '', kind: '', domainId: '', source: '', q: ' ' }, 1, 25)).toBe('page=1&limit=25');
  });

  it('count as active when anything differs from the default', () => {
    expect([hasActiveFilters(DEFAULT_CATALOG_REVIEW_FILTERS), hasActiveFilters({ ...DEFAULT_CATALOG_REVIEW_FILTERS, kind: 'new_alias' })]).toEqual([false, true]);
  });
});

describe('labels', () => {
  it('names each kind in plain words', () => {
    expect([kindLabel('new_role'), kindLabel('new_alias')]).toEqual(['New role', 'Alternative title']);
  });

  it('bands confidence', () => {
    expect([confidenceLabel(0.85), confidenceLabel(0.8), confidenceLabel(0.5), confidenceLabel(0.49)]).toEqual(['High', 'High', 'Medium', 'Low']);
  });

  it('shows confidence as a whole percentage, clamped', () => {
    expect([confidencePercent(0.856), confidencePercent(1.2), confidencePercent(-1)]).toEqual(['86%', '100%', '0%']);
  });

  it('places a new role in its domain and family', () => {
    expect(placementLabel(proposalView())).toBe('Technology · Engineering');
  });

  it('says when a new role has no domain yet', () => {
    expect(placementLabel(proposalView({ domain: null, family: null }))).toBe('No domain yet');
  });

  it('places an alternative title on its role', () => {
    expect(placementLabel(proposalView({ kind: 'new_alias', targetRole: { id: 'r', title: 'Software Engineer', status: 'active' } }))).toBe('Alternative title for Software Engineer');
  });
});

describe('source links', () => {
  it('labels an O*NET source with its occupation code', () => {
    expect(sourceLinks([{ source: 'onet', ref: '15-1252.00', url: 'https://www.onetonline.org/link/summary/15-1252.00' }])[0]).toMatchObject({ text: 'O*NET 15-1252.00', href: 'https://www.onetonline.org/link/summary/15-1252.00' });
  });

  it('labels a web source by its website', () => {
    expect(sourceLinks([{ source: 'web', ref: 'https://www.jobs.example/1', url: 'https://www.jobs.example/1' }])[0].text).toBe('jobs.example');
  });

  it('never links anything that is not http(s)', () => {
    expect(sourceLinks([{ source: 'web', ref: 'x', url: 'javascript:alert(1)' }])[0].href).toBeNull();
  });

  it('gives each link a unique key', () => {
    const links = sourceLinks([{ source: 'esco', ref: 'a' }, { source: 'esco', ref: 'a' }]);
    expect(new Set(links.map((l) => l.key)).size).toBe(2);
  });
});

describe('selection for bulk actions', () => {
  const proposals = [proposalView({ id: 'a' }), proposalView({ id: 'b' }), proposalView({ id: 'c', status: 'approved' })];

  it('adds and removes an id without changing the original set', () => {
    const selected = new Set(['a']);
    const next = toggleSelection(selected, 'b');
    expect({ before: [...selected], after: [...next].sort(), removed: [...toggleSelection(next, 'a')] }).toEqual({ before: ['a'], after: ['a', 'b'], removed: ['b'] });
  });

  it('offers only pending proposals', () => {
    expect(selectablePendingIds(proposals)).toEqual(['a', 'b']);
  });

  it('selects every pending proposal, then clears them', () => {
    const all = toggleAll(new Set(), proposals);
    expect({ all: [...all].sort(), cleared: [...toggleAll(all, proposals)] }).toEqual({ all: ['a', 'b'], cleared: [] });
  });

  it('drops ids that are no longer shown or no longer pending', () => {
    expect([...pruneSelection(new Set(['a', 'c', 'gone']), proposals)]).toEqual(['a']);
  });
});

describe('inline edit', () => {
  it('starts from the proposal', () => {
    expect(draftFrom(proposalView({ summary: 'Keeps agents up.' }))).toEqual({ title: 'Agent Reliability Engineer', domainId: 'd1', familyId: 'f1', summary: 'Keeps agents up.' });
  });

  it('offers the families used in the chosen domain', () => {
    expect(familiesFor(options, 'd2')).toEqual([{ id: 'f2', name: 'Care' }]);
  });

  it('offers no families before a domain is chosen', () => {
    expect(familiesFor(options, '')).toEqual([]);
  });

  it('mirrors the server title rules', () => {
    expect([titleProblem('A'), titleProblem('Ring 5551234567'), titleProblem('jobs@acme.test'), titleProblem('1234'), titleProblem('Staff Nurse')]).toEqual([
      'Title must be 2 to 120 characters.', 'Title must not contain requisition or phone numbers.', 'Title must not contain contact details or links.', 'Title must contain a letter.', null,
    ]);
  });

  it('requires a domain for a new role', () => {
    expect(validateEdit({ title: 'Agent Ops', domainId: '', familyId: '', summary: '' }, 'new_role', options)).toEqual({ domainId: 'Choose a domain.' });
  });

  it('refuses a family from another domain', () => {
    expect(validateEdit({ title: 'Agent Ops', domainId: 'd1', familyId: 'f2', summary: '' }, 'new_role', options)).toEqual({ familyId: 'Choose a family used in this domain.' });
  });

  it('refuses a summary over 600 characters', () => {
    expect(validateEdit({ title: 'Agent Ops', domainId: 'd1', familyId: '', summary: 'x'.repeat(601) }, 'new_role', options)).toEqual({ summary: 'Keep the summary under 600 characters.' });
  });

  it('does not ask an alternative title for a domain', () => {
    expect(validateEdit({ title: 'Staff Nurse', domainId: '', familyId: '', summary: '' }, 'new_alias', options)).toEqual({});
  });

  it('sends only what changed', () => {
    const p = proposalView();
    expect(editPatch(p, { ...draftFrom(p), title: ' Agent Ops Engineer ' })).toEqual({ title: 'Agent Ops Engineer' });
  });

  it('sends a cleared family as null', () => {
    const p = proposalView();
    expect(editPatch(p, { ...draftFrom(p), familyId: '' })).toEqual({ familyId: null });
  });

  it('never sends a domain or family for an alternative title', () => {
    const p = proposalView({ kind: 'new_alias', domain: null, family: null });
    expect(editPatch(p, { title: 'Staff Nurse', domainId: 'd1', familyId: 'f1', summary: '' })).toEqual({ title: 'Staff Nurse' });
  });
});

describe('decision messages', () => {
  it('explains a superseded proposal plainly', () => {
    expect(decisionErrorMessage({ status: 409, code: 'superseded', message: '"Data Scientist" is already in the catalog.' }, 'Data Scientist')).toBe('Not added: "Data Scientist" is already in the catalog. The proposal is marked superseded.');
  });

  it('explains a proposal that changed while the operator looked at it', () => {
    expect(decisionErrorMessage({ status: 409, code: 'changed', message: 'x' }, 'Data Scientist')).toBe('"Data Scientist" changed while you were looking at it. The list now shows the latest version; review it again.');
  });

  it('explains a manual run that is too soon', () => {
    expect(decisionErrorMessage({ status: 409, code: 'too_soon', message: 'A manual run started recently. The next one can start after 14:05 UTC.' }, 'Run now')).toBe('A manual run started recently. The next one can start after 14:05 UTC.');
  });

  it('explains a proposal someone else already decided', () => {
    expect(decisionErrorMessage({ status: 409, code: 'not_pending', message: 'x' }, 'Data Scientist')).toBe('"Data Scientist" was already reviewed. The list is up to date.');
  });

  it('passes other messages through with the title', () => {
    expect(decisionErrorMessage({ status: 400, code: 'needs_domain', message: 'Choose a domain before approving' }, 'Agent Ops')).toBe('Agent Ops: Choose a domain before approving');
  });

  it('summarises a bulk result, naming each failure', () => {
    const titles = new Map([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]);
    const outcome = bulkOutcome([{ id: 'a', ok: true }, { id: 'b', ok: false, code: 'superseded', error: '"Beta" is already in the catalog.' }, { id: 'c', ok: false, code: 'needs_domain', error: 'Choose a domain before approving' }], titles, 'approve');
    expect(outcome).toEqual({ message: 'Approved 1 of 3.', failures: ['Beta: already in the catalog (superseded).', 'Gamma: Choose a domain before approving'] });
  });

  it('summarises a clean bulk rejection', () => {
    expect(bulkOutcome([{ id: 'a', ok: true }, { id: 'b', ok: true }], new Map(), 'reject')).toEqual({ message: 'Rejected 2 of 2.', failures: [] });
  });
});

describe('runs', () => {
  it('adds up the sources', () => {
    expect(runTotals(run())).toEqual({ fetched: 15, proposed: 4, skipped: 2, errors: 1 });
  });

  it('describes a finished run in one line', () => {
    expect(runStatusLine(run())).toBe('15 read · 4 proposed · 2 skipped · 1 error · web research skipped (no OpenAI key)');
  });

  it('describes a failed run in plain words, never with server internals', () => {
    expect(runStatusLine(run({ status: 'failed', error: 'unexpected_error' }))).toMatch(/^Stopped on an unexpected error; the next run resumes it. · /);
  });

  it('never shows an unknown error text as it came', () => {
    expect(runErrorText('PrismaClientKnownRequestError: connection refused at 10.0.0.5')).toBe('Stopped on an unexpected error; the next run resumes it.');
  });

  it('explains an abandoned run', () => {
    expect(runErrorText('abandoned')).toBe('Stopped and not resumed within 7 days; a fresh run started instead.');
  });

  it('keeps Run now disabled while the latest run is still marked running', () => {
    expect(runNowDisabled([run({ status: 'running', finishedAt: null })], false)).toBe(true);
  });

  it('keeps Run now disabled while the lease is held', () => {
    expect(runNowDisabled([run()], true)).toBe(true);
  });

  it('enables Run now when nothing is running', () => {
    expect(runNowDisabled([run()], false)).toBe(false);
  });

  it('describes a run in progress', () => {
    expect(runStatusLine(run({ status: 'running', finishedAt: null }))).toMatch(/^Running/);
  });
});

describe('pagination', () => {
  it('says where the reader is', () => {
    expect(paginationLabel({ total: 112, page: 2, limit: 25, totalPages: 5 })).toBe('Page 2 of 5 · 112 proposals');
  });

  it('uses the singular for one proposal', () => {
    expect(paginationLabel({ total: 1, page: 1, limit: 25, totalPages: 1 })).toBe('Page 1 of 1 · 1 proposal');
  });
});

describe('status chips', () => {
  it('give each proposal status a label and a distinct tone', () => {
    expect(['pending', 'approved', 'rejected', 'superseded'].map((s) => [proposalStatus(s).label, proposalStatus(s).tone])).toEqual([
      ['Pending', 'hold'], ['Approved', 'pass'], ['Rejected', 'stop'], ['Already in catalog', 'neutral'],
    ]);
  });

  it('give each run status a label', () => {
    expect(['running', 'completed', 'failed'].map((s) => refreshRunStatus(s).label)).toEqual(['Running', 'Completed', 'Failed']);
  });
});
