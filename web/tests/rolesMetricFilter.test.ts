import { describe, expect, it } from 'vitest';
import { filterRoles, metricFilterFromParam, METRIC_FILTER_LABELS, type RoleFunnel } from '../src/components/rolesListModel';

const role = (overrides: Partial<RoleFunnel>): RoleFunnel => ({
  id: 'r', title: 'Backend Engineer', level: 'Senior', status: 'approved', domain: null, regionCode: null, experienceBand: null,
  applied: 0, interviewInvited: 0, interviewed: 0, awaitingReview: 0,
  decisions: { APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 },
  advanceRate: null, medianInviteToCompleteHours: null, lastActivityAt: null, updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('metricFilterFromParam', () => {
  it('reads the no-candidates filter', () => {
    expect(metricFilterFromParam('no-candidates')).toBe('no-candidates');
  });

  it('reads the awaiting-review filter', () => {
    expect(metricFilterFromParam('awaiting-review')).toBe('awaiting-review');
  });

  it('ignores an unknown filter', () => {
    expect(metricFilterFromParam('everything')).toBe(null);
  });

  it('ignores a missing filter', () => {
    expect(metricFilterFromParam(null)).toBe(null);
  });

  it('names each filter for the page', () => {
    expect(METRIC_FILTER_LABELS['no-candidates']).toBe('Roles with no candidates');
  });
});

describe('filterRoles with a dashboard filter', () => {
  const roles = [
    role({ id: 'empty', applied: 0 }),
    role({ id: 'busy', applied: 4, awaitingReview: 2 }),
    role({ id: 'quiet', applied: 3, awaitingReview: 0 }),
    role({ id: 'archived-empty', applied: 0, status: 'archived' }),
  ];

  it('keeps only active roles with no candidates', () => {
    expect(filterRoles(roles, { metric: 'no-candidates' }).map((r) => r.id)).toEqual(['empty']);
  });

  it('keeps only roles with a review backlog', () => {
    expect(filterRoles(roles, { metric: 'awaiting-review' }).map((r) => r.id)).toEqual(['busy']);
  });

  it('applies no dashboard filter when none is set', () => {
    expect(filterRoles(roles, { metric: null }).map((r) => r.id)).toEqual(['empty', 'busy', 'quiet']);
  });
});

describe('filterRoles awaiting-review on archived roles', () => {
  it('keeps an archived role that still has interviews to review, as the KPI counts it', () => {
    const roles = [role({ id: 'old', status: 'archived', awaitingReview: 1 })];
    expect(filterRoles(roles, { metric: 'awaiting-review' }).map((r) => r.id)).toEqual(['old']);
  });
});
