/**
 * Audit log query building, kept free of React so it can be unit tested in the
 * node environment (see web/tests/auditLogModel.test.ts).
 */

export interface AuditFilters {
  readonly action: string;
  readonly actorId: string;
  /** YYYY-MM-DD from a date input, in the viewer's local calendar. */
  readonly fromDate: string;
  readonly toDate: string;
  readonly page: number;
  readonly limit: number;
}

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Local midnight of a date-input value, shifted by `dayOffset` days, or null if
 * the value is not a valid date. Local rather than UTC: "events on the 5th"
 * means the viewer's 5th, not Greenwich's.
 */
function localMidnight(value: string, dayOffset: number): Date | null {
  const match = DATE_INPUT.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day + dayOffset);
}

/** Query string for GET /api/admin/audit; empty filters are omitted. */
export function buildAuditQuery(filters: AuditFilters): string {
  const params = new URLSearchParams();
  if (filters.action) params.set('action', filters.action);
  if (filters.actorId) params.set('actorId', filters.actorId);
  const from = localMidnight(filters.fromDate, 0);
  if (from) params.set('from', from.toISOString());
  const nextDay = localMidnight(filters.toDate, 1);
  // Inclusive end of the chosen day: one millisecond before the next midnight.
  if (nextDay) params.set('to', new Date(nextDay.getTime() - 1).toISOString());
  params.set('page', String(filters.page));
  params.set('limit', String(filters.limit));
  return params.toString();
}

/** Number of pages for `total` events; never fewer than one. */
export function pageCount(total: number, limit: number): number {
  return Math.max(1, Math.ceil(total / limit));
}
