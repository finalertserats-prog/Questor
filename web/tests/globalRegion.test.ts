import { describe, expect, it } from 'vitest';
import { filterRoles, regionFilterOptions, type RoleFunnel } from '../src/components/rolesListModel';
import { regionLabel, roleDetailLine, roleDisplayLabels } from '../src/components/roleLabelModel';
import { regionHint } from '../src/components/catalogModel';

// The Global region: a role open in every region. It shows under every
// specific region in the roles filter, and reads "Global" wherever a region
// is named.

const role = (overrides: Partial<RoleFunnel>): RoleFunnel => ({
  id: 'r', title: 'Backend Engineer', level: 'Senior', status: 'approved', domain: null, regionCode: null, experienceBand: null,
  applied: 0, interviewInvited: 0, interviewed: 0, awaitingReview: 0,
  decisions: { APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 },
  advanceRate: null, medianInviteToCompleteHours: null, lastActivityAt: null, updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const ids = (roles: readonly RoleFunnel[]) => roles.map((r) => r.id);

describe('filtering roles by region with Global roles', () => {
  const roles = [
    role({ id: 'india', regionCode: 'IN' }),
    role({ id: 'europe', regionCode: 'EU' }),
    role({ id: 'global', regionCode: 'GLOBAL' }),
    role({ id: 'none', regionCode: null }),
  ];

  it('shows Global roles alongside the roles of a chosen region', () => {
    expect(ids(filterRoles(roles, { regionCode: 'IN' }))).toEqual(['india', 'global']);
  });

  it('shows only Global roles when Global is chosen', () => {
    expect(ids(filterRoles(roles, { regionCode: 'GLOBAL' }))).toEqual(['global']);
  });

  it('shows every role when no region is chosen', () => {
    expect(ids(filterRoles(roles, { regionCode: '' }))).toEqual(['india', 'europe', 'global', 'none']);
  });

  it('still applies the other filters to Global roles', () => {
    const mixed = [role({ id: 'g-eng', regionCode: 'GLOBAL', domain: 'Engineering' }), role({ id: 'g-sales', regionCode: 'GLOBAL', domain: 'Sales' })];
    expect(ids(filterRoles(mixed, { regionCode: 'IN', domain: 'Sales' }))).toEqual(['g-sales']);
  });
});

describe('regionFilterOptions', () => {
  const catalog = [{ code: 'IN', name: 'India' }, { code: 'GLOBAL', name: 'Global (all regions)' }, { code: 'EU', name: 'Europe' }];

  it('lists Global first, then the rest by name', () => {
    expect(regionFilterOptions(catalog, []).map((o) => o.value)).toEqual(['GLOBAL', 'EU', 'IN']);
  });

  it('adds a code only the roles carry, labelled by the code', () => {
    expect(regionFilterOptions(catalog, ['XX']).at(-1)).toEqual({ value: 'XX', label: 'XX' });
  });

  it('lists Global first even before the catalog has loaded', () => {
    expect(regionFilterOptions([], ['IN', 'GLOBAL']).map((o) => o.label)).toEqual(['Global', 'India']);
  });
});

describe('region labels', () => {
  it('names Global as "Global"', () => {
    expect(regionLabel('GLOBAL')).toBe('Global');
  });

  it('names a specific region by name', () => {
    expect(regionLabel('IN')).toBe('India');
  });

  it('shows Global in the line under a role title', () => {
    expect(roleDetailLine({ level: 'Senior', domain: 'Engineering', regionCode: 'GLOBAL', experienceBand: 'senior' })).toBe('Senior · Engineering · Global');
  });

  it('tells a Global role apart from a same-titled regional one as "Global"', () => {
    const labels = roleDisplayLabels([
      { id: 'a', title: 'Backend Engineer', level: 'Senior', regionCode: 'GLOBAL' },
      { id: 'b', title: 'Backend Engineer', level: 'Senior', regionCode: 'IN' },
    ]);
    expect(labels).toEqual(['Backend Engineer · Global', 'Backend Engineer · IN']);
  });
});

describe('regionHint', () => {
  it('explains what choosing Global means', () => {
    expect(regionHint('GLOBAL')).toBe('Open in every region. The job description names no country, currency or visa rules, and the role shows under every region in the roles list.');
  });

  it('says nothing for a specific region', () => {
    expect(regionHint('IN')).toBe('');
  });
});
