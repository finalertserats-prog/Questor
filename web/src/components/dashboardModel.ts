/**
 * The dashboard's presentation decisions, kept free of React so they can be
 * unit tested in the node environment (see web/tests/dashboardModel.test.ts).
 */

export interface StateGroup {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

// Raw session states are the state machine's vocabulary (server
// domain/stateMachine.ts); an HR reader thinks in these five buckets instead.
const STATE_GROUPS: ReadonlyArray<{ key: string; label: string; states: readonly string[] }> = [
  { key: 'scheduled', label: 'Invited / scheduled', states: ['PROVISIONED', 'INVITED', 'ACCEPTED', 'RESCHEDULE_REQUIRED'] },
  {
    key: 'live', label: 'In progress',
    states: ['READY_CHECK', 'WAITING', 'CONNECTING', 'DISCLOSURE', 'CONSENTED', 'WARMUP', 'ASSESSING', 'CANDIDATE_QUESTIONS', 'CLOSING', 'PROCESSING'],
  },
  { key: 'review', label: 'Awaiting review', states: ['REVIEW_READY'] },
  { key: 'reviewed', label: 'Reviewed / closed', states: ['HUMAN_REVIEWED', 'CLOSED'] },
  {
    key: 'stopped', label: 'Stopped',
    states: ['NO_SHOW', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE', 'POLICY_STOP', 'MANUAL_HANDOFF', 'CANCELLED', 'INCOMPLETE'],
  },
];

/** Fold session counts by state into display groups; unknown states land in a trailing Other group. */
export function groupSessionStates(stateCounts: Readonly<Record<string, number>>): StateGroup[] {
  const known = new Set(STATE_GROUPS.flatMap((g) => g.states));
  const groups = STATE_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    count: g.states.reduce((sum, state) => sum + (stateCounts[state] ?? 0), 0),
  }));
  const other = Object.entries(stateCounts)
    .filter(([state]) => !known.has(state))
    .reduce((sum, [, count]) => sum + count, 0);
  return other > 0 ? [...groups, { key: 'other', label: 'Other', count: other }] : groups;
}

const NICE_STEPS = [1, 2, 5, 10] as const;

/** The smallest 1/2/5 × 10^n at or above `value`; 1 for an empty series. */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = NICE_STEPS.find((s) => s * magnitude >= value) ?? 10;
  return step * magnitude;
}

/** Length of a bar for `value` on an axis ending at `max`, clamped to [0, length]. */
export function scaleLength(value: number, max: number, length: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(length, (value / max) * length);
}

const HOURS_PER_DAY = 24;
const DAYS_FROM_HOURS = 48;

/** A turnaround in hours, as a compact human label. */
export function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return '<1h';
  if (hours < DAYS_FROM_HOURS) return `${Math.round(hours)}h`;
  return `${(hours / HOURS_PER_DAY).toFixed(1)}d`;
}

/** Short day-and-month label for a chart axis. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
