import { describe, it, expect } from 'vitest';
import { DEFAULT_ORG_TIME_ZONE, effectiveOrgTimeZone } from '../src/services/tenantTimeZone.js';

// The zone an organisation works in. One that never chose works in IST; the
// owner's call (2026-09-21), so every fallback agrees instead of some saying UTC.
describe('effectiveOrgTimeZone', () => {
  it('is the zone the organisation chose', () => {
    expect(effectiveOrgTimeZone({ timeZone: 'Europe/Berlin' })).toBe('Europe/Berlin');
  });

  it('is IST when none was chosen', () => {
    expect(effectiveOrgTimeZone({})).toBe('Asia/Kolkata');
  });

  it('is IST when the stored zone is unknown to the runtime', () => {
    expect(effectiveOrgTimeZone({ timeZone: 'Mars/Olympus_Mons' })).toBe('Asia/Kolkata');
  });

  it('is IST when the stored zone is not a string', () => {
    expect(effectiveOrgTimeZone({ timeZone: 330 })).toBe('Asia/Kolkata');
  });

  it('names IST as the default', () => {
    expect(DEFAULT_ORG_TIME_ZONE).toBe('Asia/Kolkata');
  });
});
