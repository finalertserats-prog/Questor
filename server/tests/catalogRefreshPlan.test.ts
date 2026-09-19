import { describe, expect, it } from 'vitest';
import { buildCatalogIndex, type CatalogCandidate } from '../src/domain/catalogMatch.js';
import { acceptDrafts, capOverflow, draftsForCandidate, type ProposalDraft } from '../src/domain/catalogProposalPlan.js';

const index = buildCatalogIndex([{ id: 'swe', title: 'Software Engineer', domainId: 'tech', familyId: 'eng', aliases: ['Developer'] }]);

function candidate(overrides: Partial<CatalogCandidate> = {}): CatalogCandidate {
  return { title: 'Software Engineer', alternateTitles: [], ref: '15-1252.00', url: 'https://onet.example/15-1252.00', source: 'onet', ...overrides };
}

function draft(overrides: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    kind: 'new_role', title: 'Robot Wrangler', normalizedTitle: 'robot wrangler', domainId: 'tech', familyId: null,
    summary: '', targetRoleId: null, sources: [{ source: 'onet', ref: 'x' }], confidence: 0.7, ...overrides,
  };
}

const rules = { known: index.known, blocked: new Set<string>(), minConfidence: 0.5 };

describe('drafting proposals from one occupation', () => {
  it('drafts alias proposals for a matched occupation, pointing at its role', () => {
    const plan = draftsForCandidate(candidate({ alternateTitles: ['App Developer'] }), index);
    expect(plan.drafts.map((d) => ({ kind: d.kind, title: d.title, targetRoleId: d.targetRoleId, domainId: d.domainId }))).toEqual([{ kind: 'new_alias', title: 'App Developer', targetRoleId: 'swe', domainId: 'tech' }]);
  });

  it('counts a matched occupation as matching the catalog', () => {
    expect(draftsForCandidate(candidate(), index).matchedExisting).toBe(true);
  });

  it('ranks earlier (more trusted) alternates above later ones', () => {
    const [first, second] = draftsForCandidate(candidate({ alternateTitles: ['App Developer', 'Coder'] }), index).drafts;
    expect(first.confidence).toBeGreaterThan(second.confidence);
  });

  it('records the source, reference, link and label on every draft', () => {
    const [alias] = draftsForCandidate(candidate({ alternateTitles: ['App Developer'] }), index).drafts;
    expect(alias.sources).toEqual([{ source: 'onet', ref: '15-1252.00', url: 'https://onet.example/15-1252.00', label: 'Software Engineer' }]);
  });

  it('drafts an unclassified new role for an unmatched occupation, with a trimmed summary', () => {
    const plan = draftsForCandidate(candidate({ title: 'Wind Turbine Technician', description: 'Inspect turbines. Repair them. Climb towers.' }), index);
    expect(plan.drafts).toMatchObject([{ kind: 'new_role', title: 'Wind Turbine Technician', domainId: null, summary: 'Inspect turbines. Repair them.' }]);
  });

  it('drafts nothing for an unmatched occupation when only aliases are wanted', () => {
    expect(draftsForCandidate(candidate({ title: 'Wind Turbine Technician' }), index, { aliasesOnly: true }).drafts).toEqual([]);
  });

  it('drafts a web title as a new role in the researched domain', () => {
    const plan = draftsForCandidate(candidate({ title: 'Agent Ops Engineer', source: 'web', domainId: 'tech', evidence: ['https://a.test/1', 'https://www.b.test/2'] }), index);
    expect(plan.drafts).toMatchObject([{ kind: 'new_role', domainId: 'tech', sources: [{ source: 'web', ref: 'https://a.test/1', url: 'https://a.test/1', label: 'a.test' }, { source: 'web', ref: 'https://www.b.test/2', url: 'https://www.b.test/2', label: 'b.test' }] }]);
  });

  it('drafts nothing for a web title the catalog already has', () => {
    expect(draftsForCandidate(candidate({ title: 'developer', source: 'web', domainId: 'tech' }), index).drafts).toEqual([]);
  });
});

describe('accepting drafts', () => {
  it('keeps a new, confident, classified draft', () => {
    expect(acceptDrafts([draft()], rules).accepted).toHaveLength(1);
  });

  it('skips a title already pending or rejected recently', () => {
    const result = acceptDrafts([draft()], { ...rules, blocked: new Set(['robot wrangler']) });
    expect({ accepted: result.accepted.length, skipped: result.skipped }).toEqual({ accepted: 0, skipped: 1 });
  });

  it('skips a title that is already a catalog title or alias', () => {
    expect(acceptDrafts([draft({ title: 'Developer', normalizedTitle: 'developer' })], rules).skipped).toBe(1);
  });

  it('keeps only the first of two drafts with the same title', () => {
    const result = acceptDrafts([draft(), draft({ title: 'Robot-Wrangler' })], rules);
    expect({ accepted: result.accepted.length, skipped: result.skipped }).toEqual({ accepted: 1, skipped: 1 });
  });

  it('skips a new role with no domain', () => {
    expect(acceptDrafts([draft({ domainId: null })], rules).skipped).toBe(1);
  });

  it('skips a new role below the confidence threshold', () => {
    expect(acceptDrafts([draft({ confidence: 0.49 })], rules).skipped).toBe(1);
  });

  it('keeps an alias whatever the classification threshold', () => {
    expect(acceptDrafts([draft({ kind: 'new_alias', targetRoleId: 'swe', confidence: 0.3 })], { ...rules, minConfidence: 0.9 }).accepted).toHaveLength(1);
  });

  it('skips a title the shared catalog must not hold', () => {
    expect(acceptDrafts([draft({ title: 'Call 5551234567', normalizedTitle: 'call 5551234567' })], rules).skipped).toBe(1);
  });
});

describe('the per-run proposal cap', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 0, minutes));

  it('drops new roles before aliases', () => {
    const rows = [
      { id: 'role-high', kind: 'new_role', confidence: 0.95, createdAt: at(0) },
      { id: 'alias-low', kind: 'new_alias', confidence: 0.4, createdAt: at(1) },
    ];
    expect(capOverflow(rows, 1)).toEqual(['role-high']);
  });

  it('drops the least confident within a kind', () => {
    const rows = [
      { id: 'a', kind: 'new_role', confidence: 0.6, createdAt: at(0) },
      { id: 'b', kind: 'new_role', confidence: 0.9, createdAt: at(1) },
      { id: 'c', kind: 'new_role', confidence: 0.7, createdAt: at(2) },
    ];
    expect(capOverflow(rows, 2)).toEqual(['a']);
  });

  it('drops the newest of equally confident proposals', () => {
    const rows = [
      { id: 'old', kind: 'new_alias', confidence: 0.8, createdAt: at(0) },
      { id: 'new', kind: 'new_alias', confidence: 0.8, createdAt: at(5) },
    ];
    expect(capOverflow(rows, 1)).toEqual(['new']);
  });

  it('drops nothing under the cap', () => {
    expect(capOverflow([{ id: 'a', kind: 'new_role', confidence: 0.1, createdAt: at(0) }], 5)).toEqual([]);
  });
});
