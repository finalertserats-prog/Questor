import { prisma } from '../db.js';
import { HttpError } from '../middleware/index.js';
import type { AuthClaims } from './auth.js';
import { DEMO_ADDED_CAPS } from './demoAccess.js';
import { demoInterviewModes, type DemoInterviewModes } from './demoPolicy.js';
import { DEMO_STORY_CANDIDATE_EMAIL } from '../seed/demoStory.js';

/**
 * What the guided tour needs to know about the sandbox it is running in: who
 * the visitor is (for the start card), where the story's records are (so each
 * beat can navigate to a real page), what the visitor may add, and which ways
 * of sitting the sample interview are on offer — the closing card shows those
 * and only those.
 */
export interface DemoStatus {
  readonly visitor: { readonly name: string; readonly firstName: string };
  readonly caps: { readonly roles: number; readonly candidates: number; readonly interviews: number };
  readonly modes: DemoInterviewModes;
  readonly story: { readonly orgSlug: string | null; readonly roleId: string; readonly candidateId: string; readonly sessionId: string; readonly assessmentId: string } | null;
}

export async function demoStatus(auth: Pick<AuthClaims, 'tenantId' | 'userId' | 'demoGrantId'>): Promise<DemoStatus> {
  const [tenant, grant, role, priya] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: auth.tenantId }, select: { isDemo: true, slug: true } }),
    prisma.demoGrant.findUnique({ where: { id: auth.demoGrantId ?? '' }, select: { name: true } }),
    prisma.role.findFirst({ where: { tenantId: auth.tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true } }),
    // The seeded one is the sandbox's first candidate with this address; a
    // candidate the visitor adds later under the same address comes after it.
    prisma.candidate.findFirst({ where: { tenantId: auth.tenantId, email: DEMO_STORY_CANDIDATE_EMAIL }, orderBy: { createdAt: 'asc' }, select: { id: true } }),
  ]);
  if (!tenant?.isDemo) throw new HttpError(403, 'Only available in a demo.');
  const name = grant?.name?.trim() ?? '';
  const session = priya ? await prisma.interviewSession.findFirst({ where: { candidateId: priya.id }, orderBy: { createdAt: 'asc' }, select: { id: true, roleId: true } }) : null;
  const assessment = session ? await prisma.assessmentVersion.findFirst({ where: { sessionId: session.id }, orderBy: { version: 'desc' }, select: { id: true } }) : null;
  // A sandbox provisioned before the story existed has no story to tell; the
  // tour then skips the beats that need one rather than pointing at nothing.
  const story = role && priya && session && assessment
    ? { orgSlug: tenant.slug ?? null, roleId: session.roleId, candidateId: priya.id, sessionId: session.id, assessmentId: assessment.id }
    : null;
  return {
    visitor: { name, firstName: name.split(/\s+/)[0] ?? '' },
    caps: { ...DEMO_ADDED_CAPS },
    modes: demoInterviewModes(),
    story,
  };
}
