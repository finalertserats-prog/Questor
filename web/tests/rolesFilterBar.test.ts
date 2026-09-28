import { describe, expect, it } from 'vitest';
import {
  EMPTY_ROLE_FILTERS,
  filterRoles,
  filtersFromParams,
  filtersToParams,
  formatRoleCount,
  hasActiveFilters,
  isSearchPending,
  mergeOptionNames,
  roleMetricsPath,
  type RoleFunnel,
} from '../src/components/rolesListModel';

// The roles page filter bar: search, domain, experience, region and status,
// kept in the URL so a filtered view can be shared and survives a reload.

const role = (overrides: Partial<RoleFunnel>): RoleFunnel => ({
  id: 'r', title: 'Backend Engineer', level: 'Senior', status: 'approved', domain: null, regionCode: null, experienceBand: null,
  applied: 0, interviewInvited: 0, interviewed: 0, awaitingReview: 0,
  decisions: { APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 },
  advanceRate: null, medianInviteToCompleteHours: null, lastActivityAt: null, updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const ids = (roles: readonly RoleFunnel[]) => roles.map((r) => r.id);

describe('filterRoles — catalog fields', () => {
  const roles = [
    role({ id: 'a', domain: 'Engineering', experienceBand: 'mid', regionCode: 'in' }),
    role({ id: 'b', domain: 'Sales', experienceBand: 'senior', regionCode: 'us' }),
    role({ id: 'c' }),
  ];

  it('narrows by experience band', () => {
    expect(ids(filterRoles(roles, { experienceBand: 'senior' }))).toEqual(['b']);
  });

  it('narrows by region', () => {
    expect(ids(filterRoles(roles, { regionCode: 'in' }))).toEqual(['a']);
  });

  it('combines domain, band and region', () => {
    expect(ids(filterRoles(roles, { domain: 'Engineering', experienceBand: 'senior', regionCode: 'in' }))).toEqual([]);
  });

  it('keeps roles not linked to the catalog under All', () => {
    expect(ids(filterRoles(roles, { domain: '', experienceBand: '', regionCode: '' }))).toEqual(['a', 'b', 'c']);
  });

  it('narrows to the ids the server search matched', () => {
    expect(ids(filterRoles(roles, { matchingIds: new Set(['b', 'c']) }))).toEqual(['b', 'c']);
  });

  it('combines the server search with a client filter', () => {
    expect(ids(filterRoles(roles, { matchingIds: new Set(['b', 'c']), regionCode: 'us' }))).toEqual(['b']);
  });
});

describe('filtersFromParams', () => {
  it('reads every filter from the URL', () => {
    const params = new URLSearchParams('q=ledger&domain=Engineering&band=mid&region=in&status=draft');
    expect(filtersFromParams(params)).toEqual({ q: 'ledger', domain: 'Engineering', band: 'mid', region: 'in', status: 'draft' });
  });

  it('defaults to no filters', () => {
    expect(filtersFromParams(new URLSearchParams())).toEqual(EMPTY_ROLE_FILTERS);
  });

  it('ignores an unknown status', () => {
    expect(filtersFromParams(new URLSearchParams('status=deleted')).status).toBe('all');
  });

  it('caps a pasted search at 200 characters', () => {
    expect(filtersFromParams(new URLSearchParams(`q=${'a'.repeat(250)}`)).q).toHaveLength(200);
  });
});

describe('filtersToParams', () => {
  it('writes only the filters that are set', () => {
    const params = filtersToParams({ ...EMPTY_ROLE_FILTERS, q: 'ledger', region: 'in' }, new URLSearchParams());
    expect(params.toString()).toBe('q=ledger&region=in');
  });

  it('keeps the dashboard metric filter', () => {
    const params = filtersToParams({ ...EMPTY_ROLE_FILTERS, band: 'mid' }, new URLSearchParams('filter=awaiting-review'));
    expect(params.toString()).toBe('filter=awaiting-review&band=mid');
  });

  it('removes a filter that was cleared', () => {
    const params = filtersToParams(EMPTY_ROLE_FILTERS, new URLSearchParams('q=x&domain=Sales&status=draft'));
    expect(params.toString()).toBe('');
  });

  it('round-trips through the URL', () => {
    const state = { q: 'data', domain: 'Engineering', band: 'mid', region: 'in', status: 'archived' as const };
    expect(filtersFromParams(filtersToParams(state, new URLSearchParams()))).toEqual(state);
  });

  it('does not write a search that is only spaces', () => {
    expect(filtersToParams({ ...EMPTY_ROLE_FILTERS, q: '   ' }, new URLSearchParams()).toString()).toBe('');
  });
});

describe('hasActiveFilters', () => {
  it('is false with nothing set', () => {
    expect(hasActiveFilters(EMPTY_ROLE_FILTERS, null)).toBe(false);
  });

  it('is true with a search', () => {
    expect(hasActiveFilters({ ...EMPTY_ROLE_FILTERS, q: 'x' }, null)).toBe(true);
  });

  it('is true with a dashboard metric filter', () => {
    expect(hasActiveFilters(EMPTY_ROLE_FILTERS, 'no-candidates')).toBe(true);
  });
});

describe('formatRoleCount', () => {
  it('shows the part of the whole when filtered', () => {
    expect(formatRoleCount(3, 12)).toBe('3 of 12 roles');
  });

  it('shows the total when nothing is hidden', () => {
    expect(formatRoleCount(12, 12)).toBe('12 roles');
  });

  it('uses the singular for one role', () => {
    expect(formatRoleCount(1, 1)).toBe('1 role');
  });

  it('uses the plural for a total of one filtered to none', () => {
    expect(formatRoleCount(0, 1)).toBe('0 of 1 role');
  });
});

describe('roleMetricsPath', () => {
  it('asks for every role without a search', () => {
    expect(roleMetricsPath('')).toBe('/roles/metrics');
  });

  it('encodes the trimmed search', () => {
    expect(roleMetricsPath('  C++ & Go ')).toBe('/roles/metrics?q=C%2B%2B+%26+Go');
  });
});

describe('isSearchPending', () => {
  it('is pending while the typed text is waiting for the debounce', () => {
    expect(isSearchPending({ draft: 'led', applied: '', loading: false })).toBe(true);
  });

  it('is pending while the search request is in flight', () => {
    expect(isSearchPending({ draft: 'ledger', applied: 'ledger', loading: true })).toBe(true);
  });

  it('is not pending when the typed text differs only by spaces', () => {
    expect(isSearchPending({ draft: 'ledger ', applied: 'ledger', loading: false })).toBe(false);
  });

  it('is settled once the result is in', () => {
    expect(isSearchPending({ draft: 'ledger', applied: 'ledger', loading: false })).toBe(false);
  });
});

describe('mergeOptionNames', () => {
  it('joins the catalog with values only the roles carry, sorted and without duplicates', () => {
    expect(mergeOptionNames(['Sales', 'Engineering'], ['Engineering', 'Legacy'])).toEqual(['Engineering', 'Legacy', 'Sales']);
  });
});
