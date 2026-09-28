import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { candidateScope, roleScope } from './access.js';
import { capabilitiesOf, type Capability } from '../domain/capabilities.js';
import { FIRST_RUN_STEPS, type FirstRunStep } from '../domain/firstRun.js';
import type { AuthClaims } from './auth.js';

/**
 * What an organisation that has not interviewed anyone yet should do next.
 *
 * Home's opening card used to be driven by the queue alone — nothing waiting,
 * nothing booked, nothing finished. All three are empty for an organisation
 * that has created a role, approved its scorecard and added a candidate, so
 * that organisation was still told "Start with a role": pointed backwards at
 * work it had already done, and never at the interview it was one click from
 * starting. Two real organisations registered and produced no events at all.
 *
 * The step is the first thing in the chain that is missing, so the card
 * advances as the work is done and disappears when the first interview exists.
 */

export { FIRST_RUN_STEPS, type FirstRunStep };

export interface FirstRun {
  readonly step: FirstRunStep;
  /** The role the step is about: the one to approve, or the one waiting for a candidate. */
  readonly roleId: string | null;
  /** The candidate waiting for an interview, when that is the step. */
  readonly candidateId: string | null;
  /**
   * Whether this reader may do it themselves. A recruiter cannot approve a
   * scorecard, and a card that offers them a button they will be refused at is
   * worse than one that tells them who to ask.
   */
  readonly canAct: boolean;
}

const CAPABILITY: Readonly<Record<FirstRunStep, Capability>> = {
  role: 'role:create',
  scorecard: 'role:approve_scorecard',
  candidate: 'candidate:create',
  interview: 'interview:invite',
};

/**
 * Asked for only when the queue, the week ahead and the week behind are all
 * empty — which an established organisation that is merely quiet today also
 * satisfies. It therefore pays for the first read below: one indexed existence
 * check on its own tenant, which answers null before anything else is read.
 */
export async function firstRunOf(auth: AuthClaims): Promise<FirstRun | null> {
  // The organisation's, not the reader's. One interview anywhere in the tenant
  // — at any state, including a provisioned one nobody has sent — means this
  // organisation has been through once, and a recruiter who cannot see that
  // candidate must not be told their established employer is new. It runs
  // first because it is the cheapest read and the usual answer.
  const interviewed = await prisma.interviewSession.findFirst({
    where: { tenantId: auth.tenantId }, select: { id: true },
  });
  if (interviewed) return null;

  const [roleScoped, candidateScoped] = await Promise.all([roleScope(auth), candidateScope(auth)]);
  const roleWhere = roleScoped as Prisma.RoleWhereInput;
  const candidateWhere = candidateScoped as Prisma.CandidateWhereInput;
  const capabilities = capabilitiesOf(auth.role);
  const step = (s: FirstRunStep, ids: { roleId?: string | null; candidateId?: string | null } = {}): FirstRun => ({
    step: s,
    roleId: ids.roleId ?? null,
    candidateId: ids.candidateId ?? null,
    canAct: capabilities.includes(CAPABILITY[s]),
  });

  const role = await prisma.role.findFirst({
    where: { AND: [roleWhere, { status: { not: 'archived' } }] },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!role) return step('role');

  // A role is open to candidates when its own status is approved AND it has an
  // approved scorecard version — the same pair the add-candidate form filters
  // on. Reading `Role.status` alone would skip the scorecard step for a role
  // nobody can actually be interviewed for.
  const approved = await prisma.role.findFirst({
    where: { AND: [roleWhere, { status: 'approved' }, { scorecards: { some: { status: 'approved' } } }] },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!approved) return step('scorecard', { roleId: role.id });

  // On the approved role, not anywhere in the tenant. An organisation whose one
  // candidate sits on a role that is still a draft has nobody to interview for
  // the role that is ready, and naming that person here would send someone to
  // set up an interview against a scorecard that does not exist.
  const candidate = await prisma.candidate.findFirst({
    where: { AND: [candidateWhere, { roleId: approved.id }] },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return step('candidate', { roleId: approved.id });

  return step('interview', { roleId: approved.id, candidateId: candidate.id });
}
