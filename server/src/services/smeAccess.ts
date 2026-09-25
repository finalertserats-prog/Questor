import { prisma } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { assignCandidate, SME_RELATION } from './access.js';
import type { AuthClaims } from './auth.js';
import type { RoleName } from '../domain/capabilities.js';

/**
 * Object scope for the subject-matter expert.
 *
 * Kept apart from `candidateScope` in services/access.ts on purpose, and the
 * difference is the point of the whole role: `candidateScope` widens for an
 * admin (`isAdmin` → the whole tenant) and it also admits anyone assigned the
 * candidate's ROLE, which is how a recruiter reaches their whole requisition.
 * An SME reaches exactly the people they were handed, by name, and nobody
 * reaches the /api/sme surface by holding a broad role instead. An admin who
 * wants to see an SME's work uses the HR surface, where it belongs.
 *
 * The mechanism is a `CandidateAssignment` with `relation: 'sme'` rather than a
 * table of its own. There is already one answer in this codebase to "who may
 * touch this candidate", and a second one would be a second thing to keep in
 * step — the kind that stays in step until the day somebody erases a candidate
 * and only one of the two hears about it.
 */

export { SME_RELATION };

/**
 * The role name an assignable expert must hold.
 *
 * Taken from the capability map rather than written again, so renaming the role
 * there cannot leave this comparing against a value nothing issues any more —
 * which would fail silently: `findAssignableSme` would start refusing every
 * expert, and `listSmes` would offer nobody, with no type error either side.
 */
export const SME_ROLE: RoleName = 'sme';

/**
 * The candidate this expert was assigned, or 404.
 *
 * 404 rather than 403 throughout, matching services/access.ts: telling a caller
 * that a candidate exists but is not theirs confirms the id, which is itself a
 * disclosure — and here the id belongs to a named person the expert has not
 * been cleared to know about.
 */
export async function assertSmeAssignment(auth: AuthClaims, candidateId: string) {
  const assignment = await prisma.candidateAssignment.findFirst({
    where: { candidateId, userId: auth.userId, relation: SME_RELATION },
    select: { candidateId: true },
  });
  if (!assignment) throw new HttpError(404, 'Candidate not found');

  // The tenant is checked on the candidate rather than on the assignment,
  // because the assignment row carries no tenant of its own. An expert whose
  // account was moved, or a row left behind by a tenant merge, must not be a
  // way across the boundary.
  const candidate = await prisma.candidate.findFirst({
    where: { id: candidateId, tenantId: auth.tenantId },
  });
  if (!candidate) throw new HttpError(404, 'Candidate not found');
  return candidate;
}

/** Every candidate currently in front of this expert, newest first. */
export async function smeAssignedCandidateIds(userId: string): Promise<string[]> {
  const rows = await prisma.candidateAssignment.findMany({
    where: { userId, relation: SME_RELATION },
    orderBy: { createdAt: 'desc' },
    select: { candidateId: true },
  });
  return rows.map((row) => row.candidateId);
}

/**
 * The expert HR named, checked before anything is granted.
 *
 * Two refusals, both deliberate. A user outside the tenant is not found — the
 * assigner never learns whether the id exists elsewhere. A user inside the
 * tenant who is not an SME is refused in as many words, because that is the
 * assigner's own colleague and a typo they can fix; and because granting it
 * anyway would quietly hand a `CandidateAssignment` to, say, an auditor, whose
 * whole point is that they do not see candidate detail. Assignment is not a
 * back door into `candidateScope`.
 */
export async function findAssignableSme(tenantId: string, userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!user) throw new HttpError(404, 'User not found');
  if (user.role !== SME_ROLE) {
    throw new HttpError(400, 'Only a subject-matter expert can be assigned a candidate to assess.');
  }
  return user;
}

/**
 * Put a candidate in front of an expert.
 *
 * Idempotent, because the HR user pressing this twice is far likelier than
 * anything the second press could usefully mean, and `assignCandidate` upserts.
 */
export async function assignSme(candidateId: string, smeUserId: string) {
  return assignCandidate(candidateId, smeUserId, SME_RELATION);
}

/**
 * Take it away again.
 *
 * `deleteMany` with the relation in the filter, so this can never remove the
 * `owner` row that a recruiter's own access rests on: unassigning an expert
 * must not be a way to lock a colleague out of their own candidate.
 */
export async function unassignSme(candidateId: string, smeUserId: string): Promise<number> {
  const { count } = await prisma.candidateAssignment.deleteMany({
    where: { candidateId, userId: smeUserId, relation: SME_RELATION },
  });
  return count;
}

export interface AssignedSme {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly assignedAt: Date;
}

/** Who is assessing this candidate, for the HR surface. */
export async function listAssignedSmes(candidateId: string): Promise<AssignedSme[]> {
  const rows = await prisma.candidateAssignment.findMany({
    where: { candidateId, relation: SME_RELATION },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, createdAt: true, user: { select: { name: true, email: true } } },
  });
  return rows.map((row) => ({
    userId: row.userId, name: row.user.name, email: row.user.email, assignedAt: row.createdAt,
  }));
}

/** The experts in this organisation an HR user may choose between. */
export async function listSmes(tenantId: string) {
  return prisma.user.findMany({
    where: { tenantId, role: SME_ROLE },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true },
  });
}
