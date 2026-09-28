import { describe, it, expect } from 'vitest';
import {
  INVITABLE_ROLES, inviteExpiryLabel, inviteFormProblem, isInvitableRole, roleBlurb, roleLabel,
} from '../src/components/inviteModel';

describe('the roles an admin may invite someone into', () => {
  // Mirrors ROLES in server/src/domain/capabilities.ts. A role offered here
  // that the server does not recognise would mail somebody an invitation to an
  // account with no capabilities at all — silently powerless rather than
  // loudly refused.
  it('is exactly the fixed set the server accepts', () => {
    expect(INVITABLE_ROLES.map((role) => role.value).sort())
      .toEqual(['admin', 'auditor', 'manager', 'recruiter', 'reviewer', 'sme']);
  });

  it('rejects a role outside it', () => {
    expect(isInvitableRole('superuser')).toBe(false);
  });

  it('rejects a near-miss typo of a real role', () => {
    expect(isInvitableRole('recruter')).toBe(false);
  });

  it('explains every one of them, so nobody is granted by a name alone', () => {
    for (const role of INVITABLE_ROLES) expect(roleBlurb(role.value).length).toBeGreaterThan(10);
  });

  // The role is the one thing on this form the admin cannot undo by asking
  // again, so what it means is stated where it is chosen.
  it('says an expert moves nobody', () => {
    expect(roleBlurb('sme')).toContain('move nobody');
  });
});

describe('roleLabel', () => {
  // `humanise(role)` title-cases the stored value, which reads as "Sme" — a
  // role nobody in the product calls that.
  it('says what the product calls an expert, not what the column stores', () => {
    expect(roleLabel('sme')).toBe('Subject-matter expert');
  });

  it('says Hiring manager rather than Manager', () => {
    expect(roleLabel('manager')).toBe('Hiring manager');
  });

  // A role from a newer server still has to render as something, and a blank
  // cell where a role should be is worse than an approximate word.
  it('falls back to the title-cased value for a role it does not know', () => {
    expect(roleLabel('program_owner')).toBe('Program owner');
  });
});

describe('inviteFormProblem', () => {
  it('accepts a complete invitation', () => {
    expect(inviteFormProblem('Sanjay Rao', 'sanjay@example.com', 'sme')).toBeNull();
  });

  it('asks for a name, which the invitation itself will carry', () => {
    expect(inviteFormProblem('  ', 'sanjay@example.com', 'sme')).toContain('name');
  });

  it('asks for an address that could be delivered to', () => {
    expect(inviteFormProblem('Sanjay Rao', 'sanjay-at-example', 'sme')).toContain('email address');
  });

  it('asks for a role', () => {
    expect(inviteFormProblem('Sanjay Rao', 'sanjay@example.com', '')).toContain('able to do');
  });
});

describe('inviteExpiryLabel', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const inHours = (hours: number) => new Date(now.getTime() + hours * 60 * 60_000).toISOString();

  // Days rather than a date: what the admin is deciding is whether to chase or
  // to reissue, and a date makes them count.
  it('counts whole days while there are some', () => {
    expect(inviteExpiryLabel(inHours(72), now)).toBe('3 days left');
  });

  it('falls back to hours inside the last two days', () => {
    expect(inviteExpiryLabel(inHours(5), now)).toBe('5 hours left');
  });

  it('says one hour in the singular', () => {
    expect(inviteExpiryLabel(inHours(1), now)).toBe('1 hour left');
  });

  // "0 hours left" reads as expired when it is not, and an admin who reissues
  // on that reading retires a link the colleague is about to use.
  it('never says zero hours', () => {
    expect(inviteExpiryLabel(inHours(0.5), now)).toBe('Less than an hour left');
  });

  it('says so once it has run out', () => {
    expect(inviteExpiryLabel(inHours(-1), now)).toBe('Expired');
  });

  it('says nothing about a date it cannot read', () => {
    expect(inviteExpiryLabel('not-a-date', now)).toBe('');
  });
});
