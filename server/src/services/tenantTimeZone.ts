import { prisma, parseJsonOptional } from '../db.js';
import { isKnownTimeZone } from './roundTime.js';

/**
 * The organisation's own time zone (policyJson.timeZone), or null when it has
 * not set one — or has one the runtime no longer knows. It is the fallback for
 * a time booked without a zone, and the picker's first suggestion.
 */
export async function tenantTimeZone(tenantId: string): Promise<string | null> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { policyJson: true } });
  const { timeZone } = parseJsonOptional<{ timeZone?: unknown }>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: tenantId, field: 'policyJson' });
  return typeof timeZone === 'string' && isKnownTimeZone(timeZone) ? timeZone : null;
}
