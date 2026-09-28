import { DEFAULT_ORG_TIME_ZONE } from './orgTimeZone';
import { currentZoneName, isValidTimeZone } from './zonedScheduleModel';

/**
 * The admin's time zone setting, kept free of React so it can be unit tested
 * (see web/tests/orgTimeZoneModel.test.ts).
 */

export interface OrgTimeZoneField {
  readonly zone: string;
  /** False while the organisation is on the IST default. */
  readonly chosen: boolean;
}

/** What the setting shows: the stored zone under its current name, else IST. */
export function orgTimeZoneField(policy: Readonly<Record<string, unknown>>): OrgTimeZoneField {
  const stored = policy.timeZone;
  if (typeof stored === 'string' && isValidTimeZone(stored)) return { zone: currentZoneName(stored), chosen: true };
  return { zone: DEFAULT_ORG_TIME_ZONE, chosen: false };
}

/** The body for PUT /api/admin/policy, or null when the text is not a zone. */
export function orgTimeZonePatch(value: string): { policy: { timeZone: string } } | null {
  const zone = value.trim();
  return isValidTimeZone(zone) ? { policy: { timeZone: currentZoneName(zone) } } : null;
}
