import { z } from 'zod';
import { prisma, parseJsonOptional } from '../db.js';
import { isKnownTimeZone } from './roundTime.js';
import { effectiveOrgTimeZone } from './tenantTimeZone.js';

/**
 * Which zone a time is stated in, and — the part that was missing — where that
 * zone came from.
 *
 * Four different facts were being collapsed into one string: the zone a round
 * was booked in, the zone the candidate was in when it was booked, the zone the
 * organisation chose, and IST because nobody chose anything. The fallback order
 * between them was never wrong. What was wrong is that the substitution was
 * silent: an organisation working in IST could not tell the difference, and
 * everybody else was reading an invented clock labelled as confidently as a
 * real one. Naming the source is what lets a screen say "this is a stand-in".
 */

export type ZoneSource =
  /** The zone the booking itself records — the recruiter chose it. */
  | 'booked'
  /** The candidate's own zone, as at the booking. */
  | 'candidate'
  /** The organisation's chosen zone, standing in for one nobody recorded. */
  | 'org'
  /** IST, standing in for an organisation that never chose either. */
  | 'org_default';

export interface ResolvedZone {
  readonly zone: string;
  readonly source: ZoneSource;
}

export const IANA_ZONE_MESSAGE = 'Use an IANA time zone such as "Asia/Kolkata".';

/** "Area/Location", any depth, plus the two bare names IANA itself defines. */
const NAMED_ZONE = /^(?:UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * A zone with rules behind it, not merely one Intl will accept.
 *
 * Intl takes a bare offset — "+05:30", "-08" — as a time zone, and formatting
 * against one works, which is exactly what makes it dangerous: an offset has no
 * DST rules, so a round booked in "+01:00" in March reads an hour out in July
 * and nothing anywhere reports a problem. A stored zone has to survive the
 * clocks changing, so only a named zone is one.
 *
 * `Intl.supportedValuesOf('timeZone')` is deliberately not used for this: the
 * list an ICU build returns is its canonical spelling of each zone, so on this
 * runtime it contains Asia/Calcutta and NOT Asia/Kolkata — which would reject
 * the organisation default. The shape test plus Intl's own lookup accepts every
 * real zone and every alias of one, and nothing else.
 */
export function isNamedTimeZone(timeZone: string): boolean {
  return NAMED_ZONE.test(timeZone) && isKnownTimeZone(timeZone);
}

/**
 * A time zone as it arrives from a client. Checked against the runtime's own
 * zone table, never merely shaped: "Mars/Olympus_Mons" is a string of the right
 * form and would be stored and then silently formatted as UTC if the only test
 * were a regex.
 */
export const timeZoneField = z.string().trim().max(64).refine(isNamedTimeZone, IANA_ZONE_MESSAGE);

/** The organisation's zone, and whether the organisation actually chose it. */
export async function orgZone(tenantId: string): Promise<ResolvedZone> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { policyJson: true } });
  const policy = parseJsonOptional<{ timeZone?: unknown }>(
    tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: tenantId, field: 'policyJson' },
  );
  const zone = effectiveOrgTimeZone(policy);
  // Chosen means chosen: an organisation that picked Asia/Kolkata and one that
  // picked nothing both work in IST, but only the first has been asked.
  const chosen = typeof policy.timeZone === 'string' && isKnownTimeZone(policy.timeZone);
  return { zone, source: chosen ? 'org' : 'org_default' };
}

/**
 * The candidate's zone as HR has it, for writing onto a booking being made or
 * moved now. Null when HR has not said — the caller records the absence rather
 * than a guess, so the readers can report it as one.
 */
export async function candidateOwnZone(tenantId: string, candidateId: string): Promise<string | null> {
  const candidate = await prisma.candidate.findFirst({ where: { id: candidateId, tenantId }, select: { timeZone: true } });
  return candidate?.timeZone && isNamedTimeZone(candidate.timeZone) ? candidate.timeZone : null;
}
