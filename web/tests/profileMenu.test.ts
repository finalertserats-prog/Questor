import { describe, it, expect } from 'vitest';
import { canManageAdmin, initialsFor, profileMenuItems } from '../src/components/profileMenuModel';

/**
 * The sidebar profile menu's decisions, kept as pure logic so they can be
 * tested in the node environment this workspace uses (no DOM, no jsdom).
 */

describe('initialsFor', () => {
  it('returns first and last initials for a full name', () => {
    expect(initialsFor('Priya Sharma')).toBe('PS');
  });

  it('uses the first and last word when there are middle names', () => {
    expect(initialsFor('Mary Anne van der Berg')).toBe('MB');
  });

  it('returns a single initial for a one-word name', () => {
    expect(initialsFor('madonna')).toBe('M');
  });

  it('falls back to a question mark for a blank name', () => {
    expect(initialsFor('   ')).toBe('?');
  });
});

describe('profileMenuItems', () => {
  it('lists Settings, Admin console, Account requests, Audit log, About, Contact and Take the tour in that order for an admin', () => {
    expect(profileMenuItems('admin').map((item) => item.label)).toEqual(['Settings', 'Admin console', 'Account requests', 'Audit log', 'About', 'Contact', 'Take the tour']);
  });

  it('omits Admin console and Audit log for a recruiter', () => {
    expect(profileMenuItems('recruiter').map((item) => item.label)).toEqual(['Settings', 'About', 'Contact', 'Take the tour']);
  });

  it('offers an auditor the Audit log but not the Admin console', () => {
    expect(profileMenuItems('auditor').map((item) => item.label)).toEqual(['Settings', 'Audit log', 'About', 'Contact', 'Take the tour']);
  });

  it('keeps Account requests to admins, who alone may decide them', () => {
    expect(profileMenuItems('auditor').some((item) => item.key === 'signups')).toBe(false);
  });

  it('omits Audit log for a manager, who does not hold audit:read', () => {
    expect(profileMenuItems('manager').some((item) => item.key === 'audit')).toBe(false);
  });

  it('points each page link at its route', () => {
    const routes = profileMenuItems('admin').flatMap((item) => (item.kind === 'link' ? [item.to] : []));
    expect(routes).toEqual(['/settings', '/admin', '/admin/signups', '/audit', '/about', '/contact']);
  });

  it('offers Catalog review to the platform owner, after the audit log', () => {
    expect(profileMenuItems('admin', { platformOperator: true }).map((item) => item.key)).toEqual(['settings', 'admin', 'signups', 'audit', 'catalog-review', 'about', 'contact', 'tour']);
  });

  it('offers Catalog review to a platform owner whatever their organisation role', () => {
    expect(profileMenuItems('recruiter', { platformOperator: true }).find((item) => item.key === 'catalog-review')).toEqual({ key: 'catalog-review', label: 'Catalog review', kind: 'link', to: '/catalog-review' });
  });

  it('hides Catalog review from everyone else, admins included', () => {
    expect(profileMenuItems('admin').some((item) => item.key === 'catalog-review')).toBe(false);
  });

  it('offers the tour to every role as an action rather than a page', () => {
    const tour = profileMenuItems('recruiter').find((item) => item.key === 'tour');
    expect(tour).toEqual({ key: 'tour', label: 'Take the tour', kind: 'action', action: 'start-tour' });
  });
});

describe('canManageAdmin', () => {
  it('lets an admin open the Admin console', () => {
    expect(canManageAdmin('admin')).toBe(true);
  });

  it('keeps the Admin console from a recruiter', () => {
    expect(canManageAdmin('recruiter')).toBe(false);
  });
});
