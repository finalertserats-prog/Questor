import { ApiError } from '../api/client';
import { isRoleOpen } from './roleDetailModel';

// Rules behind candidate reuse: a person already in Questor is found by name or
// address and set up for another role as a new application, their details and
// latest resume copied over. Each application is its own record afterwards.

export const SEARCH_MIN_CHARS = 2;

/** Said wherever details are carried over, so nobody expects later edits to follow. */
export const COPIED_DETAILS_NOTE = 'Details copied from their earlier application. Changes to one application do not change the other.';

export interface CandidateRoleEntry {
  readonly candidateId: string;
  readonly roleId: string | null;
  readonly roleTitle: string | null;
  readonly roleLevel: string | null;
}

/** One person from GET /candidates/search, with only the applications the viewer may see. */
export interface CandidatePerson {
  readonly candidateId: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
  readonly hasResume: boolean;
  readonly roles: readonly CandidateRoleEntry[];
}

export interface ReuseRole {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly latestScorecard: { readonly status: string } | null;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export function isSearchable(query: string): boolean {
  return query.trim().length >= SEARCH_MIN_CHARS;
}

/** Roles that accept candidates: an approved scorecard, and not archived. */
export function rolesAcceptingCandidates<T extends ReuseRole>(roles: readonly T[]): T[] {
  return roles.filter((r) => r.latestScorecard?.status === 'approved' && isRoleOpen(r.status));
}

/** Roles this person can still be set up for. */
export function rolesOpenToPerson<T extends ReuseRole>(roles: readonly T[], person: CandidatePerson): T[] {
  const already = new Set(person.roles.map((r) => r.roleId));
  return rolesAcceptingCandidates(roles).filter((r) => !already.has(r.id));
}

/** The role a ?roleId= link asked for when it can be chosen, else the first one. */
export function initialRoleId(roles: readonly { readonly id: string }[], requested: string | null): string {
  if (requested && roles.some((r) => r.id === requested)) return requested;
  return roles[0]?.id ?? '';
}

/** Why an existing person cannot be set up for this role yet; null when they can. */
export function reuseBlocker(person: CandidatePerson, roleId: string): string | null {
  if (!roleId) return 'Choose a role with an approved scorecard first.';
  if (person.roles.some((r) => r.roleId === roleId)) return `${person.fullName} is already a candidate for this role.`;
  return null;
}

/** The application an address already has on a role, among search results. */
export function existingApplicationFor(people: readonly CandidatePerson[], email: string, roleId: string): string | null {
  const wanted = normalizeEmail(email);
  const match = people.find((p) => normalizeEmail(p.email) === wanted);
  return match?.roles.find((r) => r.roleId === roleId)?.candidateId ?? null;
}

export function applyFailureMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'candidate_exists') return 'This person is already a candidate for that role.';
  if (err instanceof Error && err.message) return err.message;
  return 'Could not set this person up for that role.';
}

/**
 * For each application, how many OTHER roles the same address is in among the
 * rows given — the viewer's own scoped list, so nothing they cannot see is
 * counted.
 */
export function otherRoleCounts(rows: readonly { readonly id: string; readonly email: string; readonly roleId: string | null }[]): Map<string, number> {
  const rolesByEmail = rows.reduce((acc, row) => {
    const key = normalizeEmail(row.email);
    const roles = acc.get(key) ?? new Set<string>();
    return acc.set(key, row.roleId ? new Set([...roles, row.roleId]) : roles);
  }, new Map<string, ReadonlySet<string>>());
  return new Map(rows.map((row) => {
    const roles = rolesByEmail.get(normalizeEmail(row.email)) ?? new Set<string>();
    return [row.id, roles.size - (row.roleId && roles.has(row.roleId) ? 1 : 0)];
  }));
}

export function alsoInRolesLabel(count: number): string {
  if (count <= 0) return '';
  return `Also in ${count} other role${count === 1 ? '' : 's'}`;
}

/** A role's name as the reuse lists show it. */
export function roleEntryLabel(entry: CandidateRoleEntry): string {
  if (!entry.roleTitle) return 'No role';
  return entry.roleLevel ? `${entry.roleTitle} (${entry.roleLevel})` : entry.roleTitle;
}
