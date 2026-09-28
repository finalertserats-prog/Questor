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
  it('lists Settings, Admin console, People, Account requests, Audit log, About, Contact and Take the tour in that order for an admin', () => {
    expect(profileMenuItems('admin').map((item) => item.label)).toEqual(['Settings', 'Admin console', 'People', 'Account requests', 'Audit log', 'About', 'Contact', 'Take the tour']);
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
    expect(routes).toEqual(['/settings', '/admin', '/admin/users', '/admin/signups', '/audit', '/about', '/contact']);
  });

  it('offers Catalog review to the platform owner, after the audit log', () => {
    expect(profileMenuItems('admin', { platformOperator: true }).map((item) => item.key)).toEqual(['settings', 'admin', 'people', 'signups', 'audit', 'catalog-review', 'library-admin', 'about', 'contact', 'tour']);
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

  // The subject-matter expert's grant is a named list of candidates and nothing
  // organisational, so every entry that is about running the organisation is
  // absent (docs/credentials-contract.md §3).
  it('leaves an expert their own account page and the help, and nothing organisational', () => {
    expect(profileMenuItems('sme').map((item) => item.label)).toEqual(['Settings', 'About', 'Contact']);
  });

  // Settings is kept deliberately. Every organisational panel on that page is
  // gated on candidate:read or on admin, so what an expert reaches there is
  // their own name, their own password and their own remembered devices — and
  // an account that joined by choosing its own password must be able to change
  // it. See the note in profileMenuModel.ts.
  it('keeps an expert their own account page', () => {
    expect(profileMenuItems('sme').some((item) => item.key === 'settings')).toBe(true);
  });

  it('gives an expert no page that is about the organisation', () => {
    const keys = profileMenuItems('sme').map((item) => item.key);
    for (const organisational of ['admin', 'people', 'signups', 'audit']) expect(keys).not.toContain(organisational);
  });

  it('does not offer an expert a tour of pages they cannot open', () => {
    expect(profileMenuItems('sme').some((item) => item.key === 'tour')).toBe(false);
  });

  // The platform owner's standing has nothing to do with their role inside any
  // one organisation, which is the existing rule and not something the expert
  // role changes.
  it('still offers Catalog review to a platform owner who happens to be an expert', () => {
    expect(profileMenuItems('sme', { platformOperator: true }).some((item) => item.key === 'catalog-review')).toBe(true);
  });

  it('does not let an expert open the admin console', () => {
    expect(canManageAdmin('sme')).toBe(false);
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
