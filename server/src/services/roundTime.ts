/**
 * Whether the runtime knows this IANA time zone. Intl throws a RangeError for
 * an unknown one, which is the only portable way to ask.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A round's start time as the person turning up should read it.
 *
 * In the tenant's own zone, with the offset spelled out, when the tenant has
 * set one. Otherwise an ISO time whose offset is explicit — never a bare local
 * time, which a reader silently takes to be their own clock.
 */
export function formatRoundTime(at: Date, timeZone: string | undefined): string {
  if (timeZone && isKnownTimeZone(timeZone)) {
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
    }).format(at);
    return `${local} (${timeZone})`;
  }
  return `${at.toISOString().replace(/\.\d{3}Z$/, '+00:00')} (UTC)`;
}
