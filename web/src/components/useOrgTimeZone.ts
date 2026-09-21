import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { effectiveOrgTimeZone } from './orgTimeZone';

export interface OrgTimeZoneStatus {
  /** `undefined` while it loads. */
  readonly timeZone: string | undefined;
  /**
   * The zone could not be read, so IST is being assumed. Not the same as an
   * organisation that has not chosen one: a New York organisation would
   * otherwise get IST suggested with no sign anything was wrong.
   */
  readonly failed: boolean;
}

/**
 * The organisation's time zone: the picker's first suggestion, and the zone a
 * time booked without one is shown in. IST when the organisation has not set
 * one, or it could not be read (then `failed` says so) — never the viewer's clock.
 */
export function useOrgTimeZoneStatus(): OrgTimeZoneStatus {
  const [status, setStatus] = useState<OrgTimeZoneStatus>({ timeZone: undefined, failed: false });
  useEffect(() => {
    let cancelled = false;
    api.get<{ timeZone: string | null }>('/interviews/time-zone')
      .then((resp) => { if (!cancelled) setStatus({ timeZone: effectiveOrgTimeZone(resp.timeZone), failed: false }); })
      .catch(() => { if (!cancelled) setStatus({ timeZone: effectiveOrgTimeZone(null), failed: true }); });
    return () => { cancelled = true; };
  }, []);
  return status;
}

/** Just the zone, for places that only display times. */
export function useOrgTimeZone(): string | undefined {
  return useOrgTimeZoneStatus().timeZone;
}
