import { prisma, parseJsonOptional } from '../db.js';
import type { RoleSuccessProfile } from '../domain/types.js';

export const PROCTORING_DISCLOSURE_SENTENCE = 'Basic browser activity, such as tab focus changes and clipboard paste events, is monitored during the session and reviewed by a person.';

function truthyBoolean(value: unknown): boolean {
  return value === true;
}

export async function proctoringEnabledForSession(session: { tenantId: string; scorecardId?: string | null }): Promise<boolean> {
  const [tenant, scorecard] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: session.tenantId }, select: { policyJson: true } }),
    session.scorecardId
      ? prisma.roleScorecardVersion.findUnique({ where: { id: session.scorecardId }, select: { id: true, profileJson: true } })
      : Promise.resolve(null),
  ]);

  // Both reads fail closed: an unreadable policy or scorecard leaves monitoring
  // off (and undisclosed). The rubric itself is read strictly where it scores.
  const tenantPolicy = parseJsonOptional<Record<string, unknown>>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: session.tenantId, field: 'policyJson' });
  if (truthyBoolean(tenantPolicy.proctoringEnabled)) return true;

  const profile = scorecard
    ? parseJsonOptional<RoleSuccessProfile | Record<string, unknown>>(scorecard.profileJson, {}, { model: 'RoleScorecardVersion', id: scorecard.id, field: 'profileJson' })
    : {};
  const policyRules = (profile as RoleSuccessProfile).policyRules as (RoleSuccessProfile['policyRules'] & { proctoringEnabled?: unknown }) | undefined;
  return truthyBoolean(policyRules?.proctoringEnabled);
}

export async function disclosureWithProctoringPolicy(session: { tenantId: string; scorecardId?: string | null }, baseDisclosure: string): Promise<string> {
  if (!await proctoringEnabledForSession(session)) return baseDisclosure;
  return baseDisclosure.includes(PROCTORING_DISCLOSURE_SENTENCE)
    ? baseDisclosure
    : `${baseDisclosure} ${PROCTORING_DISCLOSURE_SENTENCE}`;
}
