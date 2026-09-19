import { describe, it, expect } from 'vitest';
import { approvePayload, archiveAction, isCurrentResponse } from '../src/components/roleDetailModel';
import { canApproveRoles } from '../src/components/profileMenuModel';

describe('approvePayload', () => {
  it('names the scorecard and version being approved', () => {
    expect(approvePayload({ id: 'sc1', version: 3 })).toEqual({ scorecardId: 'sc1', version: 3 });
  });
});

describe('archiveAction', () => {
  it('offers to archive an active role', () => {
    expect(archiveAction('approved')).toEqual({ label: 'Archive role', next: 'archived' });
  });

  it('offers to archive a draft role', () => {
    expect(archiveAction('draft').next).toBe('archived');
  });

  it('offers to restore an archived role', () => {
    expect(archiveAction('archived')).toEqual({ label: 'Unarchive role', next: 'active' });
  });
});

describe('isCurrentResponse', () => {
  it('accepts the newest response for the role on screen', () => {
    expect(isCurrentResponse({ id: 'r1', seq: 2 }, { id: 'r1', seq: 2 })).toBe(true);
  });

  it('ignores a response for the role the person has left', () => {
    expect(isCurrentResponse({ id: 'r1', seq: 2 }, { id: 'r2', seq: 3 })).toBe(false);
  });

  it('ignores an older response for the same role', () => {
    expect(isCurrentResponse({ id: 'r1', seq: 1 }, { id: 'r1', seq: 2 })).toBe(false);
  });
});

describe('canApproveRoles', () => {
  it('lets a manager approve', () => {
    expect(canApproveRoles('manager')).toBe(true);
  });

  it('lets an admin approve', () => {
    expect(canApproveRoles('admin')).toBe(true);
  });

  it('does not let a recruiter approve', () => {
    expect(canApproveRoles('recruiter')).toBe(false);
  });
});
