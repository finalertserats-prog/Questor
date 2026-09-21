import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import {
  alsoInRolesLabel,
  applyFailureMessage,
  existingApplicationFor,
  existingApplicationId,
  alreadyOnRoleNotice,
  initialRoleId,
  isSearchable,
  otherRoleCounts,
  reuseBlocker,
  rolesOpenToPerson,
  type CandidatePerson,
  type ReuseRole,
} from '../src/components/candidateReuseModel';

/**
 * Candidate reuse on the web: the type-ahead that finds a person already in
 * Questor, the roles they can still be set up for, and the "also in" hint on
 * the candidates list. The pages are thin over these rules.
 */

function person(over: Partial<CandidatePerson> = {}): CandidatePerson {
  return {
    candidateId: 'cand-1', fullName: 'Asha Rao', email: 'asha@example.com', phone: '', hasResume: true,
    roles: [{ candidateId: 'cand-1', roleId: 'role-1', roleTitle: 'Data Engineer', roleLevel: 'Senior' }],
    ...over,
  };
}

function role(over: Partial<ReuseRole> = {}): ReuseRole {
  return { id: 'role-2', title: 'Platform Engineer', status: 'approved', latestScorecard: { status: 'approved' }, ...over };
}

describe('isSearchable', () => {
  it('waits for two characters', () => {
    expect(isSearchable(' a ')).toBe(false);
  });

  it('searches from two characters on', () => {
    expect(isSearchable('as')).toBe(true);
  });
});

describe('rolesOpenToPerson', () => {
  it('offers an approved, open role the person is not in', () => {
    expect(rolesOpenToPerson([role()], person()).map((r) => r.id)).toEqual(['role-2']);
  });

  it('leaves out a role the person is already in', () => {
    expect(rolesOpenToPerson([role({ id: 'role-1' })], person())).toEqual([]);
  });

  it('leaves out a role without an approved scorecard', () => {
    expect(rolesOpenToPerson([role({ latestScorecard: { status: 'draft' } })], person())).toEqual([]);
  });

  it('leaves out an archived role', () => {
    expect(rolesOpenToPerson([role({ status: 'archived' })], person())).toEqual([]);
  });
});

describe('initialRoleId', () => {
  it('picks the role named in the link when it can be chosen', () => {
    expect(initialRoleId([role({ id: 'a' }), role({ id: 'b' })], 'b')).toBe('b');
  });

  it('falls back to the first role when the named one cannot be chosen', () => {
    expect(initialRoleId([role({ id: 'a' })], 'gone')).toBe('a');
  });

  it('is empty when there is nothing to choose', () => {
    expect(initialRoleId([], null)).toBe('');
  });
});

describe('reuseBlocker', () => {
  it('allows a role the person is not in yet', () => {
    expect(reuseBlocker(person(), 'role-2')).toBeNull();
  });

  it('asks for a role first', () => {
    expect(reuseBlocker(person(), '')).toMatch(/role/i);
  });

  it('says so when the person is already in the chosen role', () => {
    expect(reuseBlocker(person(), 'role-1')).toMatch(/already/i);
  });
});

describe('existingApplicationFor', () => {
  it('finds the application a person already has on a role', () => {
    expect(existingApplicationFor([person()], 'asha@example.com', 'role-1')).toBe('cand-1');
  });

  it('matches the address whatever its capitals', () => {
    expect(existingApplicationFor([person({ email: 'ASHA@example.com' })], ' Asha@Example.com', 'role-1')).toBe('cand-1');
  });

  it('is null when the person has no application there', () => {
    expect(existingApplicationFor([person()], 'asha@example.com', 'role-9')).toBeNull();
  });
});

describe('applyFailureMessage', () => {
  it('says the person is already a candidate for a 409 naming that', () => {
    expect(applyFailureMessage(new ApiError(409, 'x', 'candidate_exists'))).toMatch(/already a candidate/i);
  });

  it('passes other server messages through', () => {
    expect(applyFailureMessage(new ApiError(409, 'This role is archived.', 'role_archived'))).toBe('This role is archived.');
  });

  it('has a fallback for anything else', () => {
    expect(applyFailureMessage('boom')).toMatch(/could not/i);
  });
});

describe('otherRoleCounts', () => {
  const rows = [
    { id: 'a', email: 'asha@example.com', roleId: 'r1' },
    { id: 'b', email: ' ASHA@example.com', roleId: 'r2' },
    { id: 'c', email: 'ben@example.com', roleId: 'r1' },
  ];

  it('counts the other roles the same address is in', () => {
    expect(otherRoleCounts(rows).get('a')).toBe(1);
  });

  it('counts none for a person in one role', () => {
    expect(otherRoleCounts(rows).get('c')).toBe(0);
  });

  it('counts a role once however many rows share it', () => {
    expect(otherRoleCounts([...rows, { id: 'd', email: 'asha@example.com', roleId: 'r2' }]).get('a')).toBe(1);
  });
});

describe('alsoInRolesLabel', () => {
  it('says nothing for none', () => {
    expect(alsoInRolesLabel(0)).toBe('');
  });

  it('uses the singular for one', () => {
    expect(alsoInRolesLabel(1)).toBe('Also in 1 other role');
  });

  it('uses the plural for several', () => {
    expect(alsoInRolesLabel(3)).toBe('Also in 3 other roles');
  });
});

describe('existingApplicationId', () => {
  it('is the application a candidate_exists refusal names', () => {
    expect(existingApplicationId(new ApiError(409, 'x', 'candidate_exists', 'cand-7'))).toBe('cand-7');
  });

  it('is null for a candidate_exists refusal that names none', () => {
    expect(existingApplicationId(new ApiError(409, 'x', 'candidate_exists'))).toBeNull();
  });

  it('is null for any other refusal', () => {
    expect(existingApplicationId(new ApiError(409, 'x', 'role_archived', 'cand-7'))).toBeNull();
  });
});

describe('alreadyOnRoleNotice', () => {
  it('names the person', () => {
    expect(alreadyOnRoleNotice('Asha Rao')).toBe('Asha Rao is already a candidate for this role.');
  });

  it('has a fallback when no name was typed', () => {
    expect(alreadyOnRoleNotice('  ')).toBe('This person is already a candidate for this role.');
  });
});
