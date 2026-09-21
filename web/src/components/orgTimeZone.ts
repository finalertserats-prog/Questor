/**
 * The zone an organisation works in until it chooses one. The owner's call
 * (2026-09-21): IST. The same rule as server/src/services/tenantTimeZone.ts,
 * so the console, the email and the portal agree on a time booked without a
 * zone instead of some of them saying UTC and others the viewer's clock.
 */
export const DEFAULT_ORG_TIME_ZONE = 'Asia/Kolkata';

function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The organisation's zone as reported, or IST when it has none, it has not
 * loaded yet, or this browser does not know it. The single web fallback for
 * "no zone on the booking".
 */
export function effectiveOrgTimeZone(orgZone: string | null | undefined): string {
  return orgZone && isKnownTimeZone(orgZone) ? orgZone : DEFAULT_ORG_TIME_ZONE;
}
