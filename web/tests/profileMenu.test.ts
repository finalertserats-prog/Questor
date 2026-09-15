import { describe, it, expect } from 'vitest';
import { initialsFor, profileMenuItems } from '../src/components/profileMenuModel';

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
  it('lists Settings, Admin console, Audit log, About and Contact in that order for an admin', () => {
    expect(profileMenuItems('admin').map((item) => item.label)).toEqual(['Settings', 'Admin console', 'Audit log', 'About', 'Contact']);
  });

  it('omits Admin console and Audit log for a recruiter', () => {
    expect(profileMenuItems('recruiter').map((item) => item.label)).toEqual(['Settings', 'About', 'Contact']);
  });

  it('offers an auditor the Audit log but not the Admin console', () => {
    expect(profileMenuItems('auditor').map((item) => item.label)).toEqual(['Settings', 'Audit log', 'About', 'Contact']);
  });

  it('omits Audit log for a manager, who does not hold audit:read', () => {
    expect(profileMenuItems('manager').some((item) => item.key === 'audit')).toBe(false);
  });

  it('points each item at its route', () => {
    expect(profileMenuItems('admin').map((item) => item.to)).toEqual(['/settings', '/admin', '/audit', '/about', '/contact']);
  });
});
