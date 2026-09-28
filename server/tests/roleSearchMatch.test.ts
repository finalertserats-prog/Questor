import { describe, expect, it } from 'vitest';
import { roleMatchesQuery } from '../src/services/roleSearch.js';

// The matching rule behind GET /api/roles/metrics?q=, without a database.

const profile = JSON.stringify({
  responsibilities: ['Build weekly retention dashboards'],
  competencies: [{ id: 'c1', name: 'Statistical reasoning', definition: 'Chooses the right significance test' }],
});

const role = (o: { title?: string; sourceText?: string; profileJson?: string } = {}) => ({
  title: o.title ?? 'Data Analyst',
  sourceText: o.sourceText ?? 'Own the payments ledger.',
  profileJson: o.profileJson ?? profile,
});

describe('roleMatchesQuery', () => {
  it('matches the title', () => {
    expect(roleMatchesQuery(role(), 'analyst')).toBe(true);
  });

  it('matches the job description', () => {
    expect(roleMatchesQuery(role(), 'payments ledger')).toBe(true);
  });

  it('matches a responsibility', () => {
    expect(roleMatchesQuery(role(), 'retention')).toBe(true);
  });

  it('matches a competency name', () => {
    expect(roleMatchesQuery(role(), 'statistical')).toBe(true);
  });

  it('matches a competency definition', () => {
    expect(roleMatchesQuery(role(), 'significance')).toBe(true);
  });

  it('ignores case', () => {
    expect(roleMatchesQuery(role(), 'RETENTION DASH')).toBe(true);
  });

  it('ignores case beyond ASCII', () => {
    expect(roleMatchesQuery(role({ title: 'Ingénieur Système' }), 'INGÉNIEUR')).toBe(true);
  });

  it('does not match JSON keys of the scorecard', () => {
    expect(roleMatchesQuery(role(), 'responsibilities')).toBe(false);
  });

  it('does not match anything else', () => {
    expect(roleMatchesQuery(role(), 'astronaut')).toBe(false);
  });

  it('tolerates a scorecard that is not valid JSON', () => {
    expect(roleMatchesQuery(role({ profileJson: '{not json' }), 'analyst')).toBe(true);
  });

  it('tolerates a scorecard of the wrong shape', () => {
    expect(roleMatchesQuery(role({ profileJson: JSON.stringify({ responsibilities: 'x', competencies: [null, 3] }) }), 'retention')).toBe(false);
  });
});
