import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * The organisation's time zone: the picker's first suggestion, and the zone a
 * time booked without one is shown in. `undefined` while it loads, `null` when
 * the organisation has not set one (or it could not be read — displays then
 * fall back to UTC, labelled, rather than to the viewer's clock).
 */
export function useOrgTimeZone(): string | null | undefined {
  const [timeZone, setTimeZone] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    api.get<{ timeZone: string | null }>('/interviews/time-zone')
      .then((resp) => { if (!cancelled) setTimeZone(resp.timeZone); })
      .catch(() => { if (!cancelled) setTimeZone(null); });
    return () => { cancelled = true; };
  }, []);
  return timeZone;
}
