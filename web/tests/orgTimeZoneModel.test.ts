import { describe, it, expect } from 'vitest';
import { DEFAULT_ORG_TIME_ZONE, effectiveOrgTimeZone } from '../src/components/orgTimeZone';
import { orgTimeZoneField, orgTimeZonePatch } from '../src/components/orgTimeZoneModel';

// An organisation that never chose a zone works in IST (owner's call,
// 2026-09-21). The same rule as server/src/services/tenantTimeZone.ts.
describe('effectiveOrgTimeZone', () => {
  it('is the zone the organisation chose', () => {
    expect(effectiveOrgTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('is IST when none was chosen', () => {
    expect(effectiveOrgTimeZone(null)).toBe('Asia/Kolkata');
  });

  it('is IST while the zone is still loading', () => {
    expect(effectiveOrgTimeZone(undefined)).toBe('Asia/Kolkata');
  });

  it('is IST for a zone the browser does not know', () => {
    expect(effectiveOrgTimeZone('Mars/Olympus_Mons')).toBe('Asia/Kolkata');
  });

  it('names IST as the default', () => {
    expect(DEFAULT_ORG_TIME_ZONE).toBe('Asia/Kolkata');
  });
});

describe('the time zone setting', () => {
  it('shows the stored zone as chosen', () => {
    expect(orgTimeZoneField({ timeZone: 'Europe/Berlin' })).toEqual({ zone: 'Europe/Berlin', chosen: true });
  });

  it('shows IST, not chosen, when nothing is stored', () => {
    expect(orgTimeZoneField({})).toEqual({ zone: 'Asia/Kolkata', chosen: false });
  });

  it('shows a stored old spelling under its current name', () => {
    expect(orgTimeZoneField({ timeZone: 'Asia/Calcutta' })).toEqual({ zone: 'Asia/Kolkata', chosen: true });
  });

  it('sends a picked zone as a policy patch', () => {
    expect(orgTimeZonePatch(' America/New_York ')).toEqual({ policy: { timeZone: 'America/New_York' } });
  });

  it('refuses to send something that is not a zone', () => {
    expect(orgTimeZonePatch('Kolkata')).toBeNull();
  });
});
