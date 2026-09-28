import { describe, expect, it } from 'vitest';
import { filterRoles, formatAdvanceRate, formatTurnaround, sortRoles, type RoleFunnel } from '../src/components/rolesListModel';

const role = (overrides: Partial<RoleFunnel>): RoleFunnel => ({
  id: overrides.id ?? 'r',
  title: overrides.title ?? 'Backend Engineer',
  level: overrides.level ?? 'Senior',
  status: overrides.status ?? 'approved',
  applied: overrides.applied ?? 0,
  interviewInvited: overrides.interviewInvited ?? 0,
  interviewed: overrides.interviewed ?? 0,
  awaitingReview: overrides.awaitingReview ?? 0,
  decisions: overrides.decisions ?? { APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 },
  advanceRate: overrides.advanceRate ?? null,
  medianInviteToCompleteHours: overrides.medianInviteToCompleteHours ?? null,
  lastActivityAt: overrides.lastActivityAt ?? null,
  updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
});

describe('filterRoles', () => {
  it('hides archived roles by default', () => {
    expect(filterRoles([role({ id: 'a' }), role({ id: 'b', status: 'archived' })], { query: '' }).map((r) => r.id)).toEqual(['a']);
  });

  it('matches title and level case-insensitively', () => {
    const roles = [role({ id: 'a', title: 'Data Analyst', level: 'L3' }), role({ id: 'b', title: 'Frontend', level: 'Principal' })];
    expect(filterRoles(roles, { query: 'principal', status: 'all' }).map((r) => r.id)).toEqual(['b']);
    expect(filterRoles(roles, { query: 'DATA', status: 'all' }).map((r) => r.id)).toEqual(['a']);
  });

  it('filters by explicit status', () => {
    expect(filterRoles([role({ id: 'a', status: 'draft' }), role({ id: 'b', status: 'approved' })], { query: '', status: 'draft' }).map((r) => r.id)).toEqual(['a']);
  });
});

describe('sortRoles', () => {
  it('sorts on a requested key without mutating input', () => {
    const roles = [role({ id: 'a', applied: 2 }), role({ id: 'b', applied: 5 })];
    expect(sortRoles(roles, 'applied', 'desc').map((r) => r.id)).toEqual(['b', 'a']);
    expect(roles.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps nulls last in both directions', () => {
    const roles = [role({ id: 'a', advanceRate: null }), role({ id: 'b', advanceRate: 0.2 }), role({ id: 'c', advanceRate: 0.8 })];
    expect(sortRoles(roles, 'advanceRate', 'asc').map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(sortRoles(roles, 'advanceRate', 'desc').map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('is stable for equal values', () => {
    const roles = [role({ id: 'a', interviewed: 1 }), role({ id: 'b', interviewed: 1 })];
    expect(sortRoles(roles, 'interviewed', 'asc').map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('formatting', () => {
  it('formats rates and low-sample rates', () => {
    expect(formatAdvanceRate(0.624)).toBe('62%');
    expect(formatAdvanceRate(null)).toBe('Too few to rate');
  });

  it('formats turnaround using dashboard hours labels and a low-sample label', () => {
    expect(formatTurnaround(60)).toBe('2.5d');
    expect(formatTurnaround(null)).toBe('Too few to rate');
  });
});
