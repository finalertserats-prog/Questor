import { prisma, parseJsonOptional } from '../db.js';
import { isKnownTimeZone } from './roundTime.js';

/**
 * The zone an organisation works in until it chooses one. The owner's call
 * (2026-09-21): IST, so a time booked without a zone reads the same in the
 * email, the portal and the console instead of some of them saying UTC.
 */
export const DEFAULT_ORG_TIME_ZONE = 'Asia/Kolkata';

/**
 * The organisation's zone from its policy: the one it chose, or IST when it
 * has not chosen one (or chose one the runtime no longer knows). The single
 * fallback every "no zone on the booking" path goes through.
 */
export function effectiveOrgTimeZone(policy: Readonly<{ timeZone?: unknown }>): string {
  const { timeZone } = policy;
  return typeof timeZone === 'string' && isKnownTimeZone(timeZone) ? timeZone : DEFAULT_ORG_TIME_ZONE;
}

/**
 * The organisation's effective time zone (see effectiveOrgTimeZone). It is the
 * fallback for a time booked without a zone, and the picker's first suggestion.
 */
export async function tenantTimeZone(tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { policyJson: true } });
  return effectiveOrgTimeZone(parseJsonOptional<{ timeZone?: unknown }>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: tenantId, field: 'policyJson' }));
}
