import { prisma } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { capabilitiesOf, type Capability } from '../domain/capabilities.js';
import type { AuthClaims } from './auth.js';

export { capabilitiesOf, isRoleName, ROLES, type Capability, type RoleName } from '../domain/capabilities.js';

// Object-level access control.
//
// Two questions must both be answered, and conflating them is how this goes
// wrong:
//
//   capability — "may this user perform this KIND of action?"  (approve a
//                scorecard, override an assessment, erase a candidate)
//   scope      — "may this user touch THIS object?"            (this candidate,
//                this session, this assessment)
//
// Before this existed, every route answered only "is the caller authenticated
// and in the right tenant?", so any logged-in recruiter could read every
// candidate's transcript, override any assessment and export anyone to the ATS.
// A capability check alone would not have fixed that: `assessment:override`
// says the user may override assessments, not that they may override THIS one.

export function hasCapability(auth: AuthClaims, cap: Capability): boolean {
  return capabilitiesOf(auth.role).includes(cap);
}

/**
 * Admin is tenant-wide by design, but it is break-glass rather than the normal
 * working mode. If every HR user is an admin, object scoping is decorative and
 * the "meaningful human review" argument that keeps this outside GDPR Art. 22
 * collapses with it.
 */
function isAdmin(auth: AuthClaims): boolean {
  return auth.role === 'admin';
}

/** Role ids this user may work with (admins: handled by caller, not listed). */
export async function assignedRoleIds(userId: string): Promise<string[]> {
  const rows = await prisma.roleAssignment.findMany({ where: { userId }, select: { roleId: true } });
  return rows.map((r) => r.roleId);
}

/** Candidate ids assigned directly to this user, independent of any role. */
export async function assignedCandidateIds(userId: string): Promise<string[]> {
  const rows = await prisma.candidateAssignment.findMany({ where: { userId }, select: { candidateId: true } });
  return rows.map((r) => r.candidateId);
}

/**
 * Prisma `where` fragment restricting candidates to those this user may see.
 *
 * Unassigned candidates resolve to admin-only rather than to everyone. Defaulting
 * unowned objects to "visible to all" would preserve exactly the exposure this
 * is meant to close, and it is the failure that would go unnoticed because
 * nothing appears broken.
 */
export async function candidateScope(auth: AuthClaims): Promise<Record<string, unknown>> {
  if (isAdmin(auth)) return { tenantId: auth.tenantId };
  const [roleIds, candidateIds] = await Promise.all([
    assignedRoleIds(auth.userId),
    assignedCandidateIds(auth.userId),
  ]);
  return {
    tenantId: auth.tenantId,
    OR: [
      { id: { in: candidateIds } },
      ...(roleIds.length ? [{ roleId: { in: roleIds } }] : []),
    ],
  };
}

export async function roleScope(auth: AuthClaims): Promise<Record<string, unknown>> {
  if (isAdmin(auth)) return { tenantId: auth.tenantId };
  return { tenantId: auth.tenantId, id: { in: await assignedRoleIds(auth.userId) } };
}

// 404 rather than 403 throughout: telling an unauthorised caller that an object
// exists but is off-limits confirms the id, which is itself a disclosure.
const notFound = (what: string) => new HttpError(404, `${what} not found`);

// AND, never a spread. `roleScope` returns its own `id` key (`id: { in: [...] }`),
// so `{ id: roleId, ...scope }` let the spread OVERWRITE the requested id: the
// lookup then ignored which object was asked for and returned an arbitrary one
// the caller already owned. That silently turned
// `PUT /roles/:someoneElsesId/scorecard` into an edit of the caller's OWN
// scorecard, and let a candidate be planted into another recruiter's pipeline —
// a wrong-object write that raises no error. Reversing the spread order is not
// a fix either; it drops the scope and restores the original tenant-wide leak.
export async function assertCanAccessRole(auth: AuthClaims, roleId: string) {
  const role = await prisma.role.findFirst({ where: { AND: [{ id: roleId }, await roleScope(auth)] } });
  if (!role) throw notFound('Role');
  return role;
}

export async function assertCanAccessCandidate(auth: AuthClaims, candidateId: string) {
  const candidate = await prisma.candidate.findFirst({ where: { AND: [{ id: candidateId }, await candidateScope(auth)] } });
  if (!candidate) throw notFound('Candidate');
  return candidate;
}

export async function assertCanAccessSession(auth: AuthClaims, sessionId: string) {
  const session = await prisma.interviewSession.findFirst({
    where: { id: sessionId, tenantId: auth.tenantId },
    include: { candidate: { select: { id: true } } },
  });
  if (!session) throw notFound('Interview');
  // Sessions inherit their candidate's scope — there is no separate notion of
  // being assigned an interview without being assigned the person.
  await assertCanAccessCandidate(auth, session.candidateId);
  return session;
}

export async function assertCanAccessAssessment(auth: AuthClaims, assessmentId: string) {
  const assessment = await prisma.assessmentVersion.findUnique({
    where: { id: assessmentId },
    include: { session: { include: { candidate: true, role: true } } },
  });
  if (!assessment || assessment.session.tenantId !== auth.tenantId) throw notFound('Assessment');
  await assertCanAccessCandidate(auth, assessment.session.candidateId);
  return assessment;
}

/** Grant access. Used when a role or candidate is created, and by admins. */
export async function assignRole(roleId: string, userId: string, relation = 'owner') {
  return prisma.roleAssignment.upsert({
    where: { roleId_userId: { roleId, userId } },
    create: { roleId, userId, relation },
    update: { relation },
  });
}

export async function assignCandidate(candidateId: string, userId: string, relation = 'owner') {
  return prisma.candidateAssignment.upsert({
    where: { candidateId_userId: { candidateId, userId } },
    create: { candidateId, userId, relation },
    update: { relation },
  });
}

/**
 * Whether this user personally drove the interview behind an assessment.
 *
 * Advisory-only status under GDPR Art. 22 and NYC LL144 rests on the human
 * review being independent. A reviewer signing off their own interview is the
 * weakest version of that, so callers surface it rather than silently allowing
 * it. Enforcement is deliberately soft — a five-person team may have nobody
 * else available, and a hard block would just push everyone to admin.
 */
export async function ranTheInterview(userId: string, sessionId: string): Promise<boolean> {
  const drove = await prisma.auditEvent.count({
    where: {
      entityId: sessionId,
      actorId: userId,
      action: { in: ['interview.started.by_recruiter', 'interview.turn.by_recruiter'] },
    },
  });
  return drove > 0;
}
