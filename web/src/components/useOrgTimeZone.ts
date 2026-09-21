import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { effectiveOrgTimeZone } from './orgTimeZone';

/**
 * The organisation's time zone: the picker's first suggestion, and the zone a
 * time booked without one is shown in. `undefined` while it loads; IST when
 * the organisation has not set one, or it could not be read — never the
 * viewer's clock.
 */
export function useOrgTimeZone(): string | undefined {
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    api.get<{ timeZone: string | null }>('/interviews/time-zone')
      .then((resp) => { if (!cancelled) setTimeZone(effectiveOrgTimeZone(resp.timeZone)); })
      .catch(() => { if (!cancelled) setTimeZone(effectiveOrgTimeZone(null)); });
    return () => { cancelled = true; };
  }, []);
  return timeZone;
}
