import { prisma, parseJsonOptional } from '../db.js';

function truthyBoolean(value: unknown): boolean {
  return value === true;
}

export async function candidateFeedbackEnabledForTenant(tenantId: string): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { policyJson: true } });
  const tenantPolicy = parseJsonOptional<Record<string, unknown>>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: tenantId, field: 'policyJson' });
  return truthyBoolean(tenantPolicy.candidateFeedbackEnabled);
}
