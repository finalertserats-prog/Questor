import { describe, it, expect } from 'vitest';
import { can, onlyWhoCan } from '../src/components/capabilityModel';

describe('can', () => {
  it('is true for a capability the user holds', () => {
    expect(can({ capabilities: ['candidate:read', 'assessment:review'] }, 'assessment:review')).toBe(true);
  });

  it('is false for one they do not', () => {
    expect(can({ capabilities: ['candidate:read'] }, 'assessment:review')).toBe(false);
  });

  it('is false when nobody is signed in', () => {
    expect(can(null, 'candidate:read')).toBe(false);
  });

  it('leaves the decision to the server when the list is missing', () => {
    expect(can({}, 'assessment:review')).toBe(true);
  });
});

describe('onlyWhoCan', () => {
  it('names who may approve a scorecard', () => {
    expect(onlyWhoCan('role:approve_scorecard', 'approve the scorecard')).toBe('Only a hiring manager or an admin can approve the scorecard.');
  });
});

/**
 * The refusal the /admin routes show. It used to say "someone with
 * permission", which tells a recruiter nothing about whom to ask.
 */
describe('the admin console refusal', () => {
  it('names who may open it', () => {
    expect(onlyWhoCan('admin:manage', 'open the admin console')).toBe('Only an admin can open the admin console.');
  });

  it('names who may read the audit log', () => {
    expect(onlyWhoCan('audit:read', 'read the audit log')).toBe('Only an admin or an auditor can read the audit log.');
  });
});
