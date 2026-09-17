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

/**
 * What the charts say about themselves when they were not drawn from
 * everything.
 *
 * The server caps how many rows it will read for the metrics
 * (services/dashboardMetrics.ts) and sets `truncated` when it hit that cap. A
 * chart of "the most recent 20,000" presented as a chart of everything is the
 * kind of thing someone plans hiring on, so the page says which one it is.
 */
export const TRUNCATION_NOTE = 'Charts and averages were computed from the most recent 20,000 records only.';

/** The line to show under the charts, or null when the series covers everything. */
export function truncationNote(truncated: unknown): string | null {
  return truncated === true ? TRUNCATION_NOTE : null;
}

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

// Finer than the usual 1/2/5: with only those steps a series topping out at
// 30 is drawn against an axis of 50, and 40% of the plot is dead space that
// no data can ever reach. These steps still produce round, readable ticks.
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

/** The smallest nice step × 10^n at or above `value`; 1 for an empty series. */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = NICE_STEPS.find((s) => s * magnitude >= value) ?? 10;
  return step * magnitude;
}

export interface CountAxis {
  readonly max: number;
  readonly ticks: readonly number[];
}

// Whole-number steps only. A count axis split into quarters of a nice ceiling
// labelled five interviews as 1.3, 2.5 and 3.8 — values no week can have.
const COUNT_STEP_BASES = [1, 2, 5] as const;
const MAX_COUNT_INTERVALS = 6;

/**
 * An axis for counts: the smallest round integer step that covers `value` in
 * at most six intervals, ending on the first multiple of that step at or above
 * `value`. Every tick is a whole number; an empty series gets 0 to 1.
 */
export function countAxis(value: number): CountAxis {
  const top = Math.max(1, Math.ceil(value));
  let step = 1;
  for (let magnitude = 1; ; magnitude *= 10) {
    const found = COUNT_STEP_BASES.map((base) => base * magnitude).find((s) => Math.ceil(top / s) <= MAX_COUNT_INTERVALS);
    if (found !== undefined) {
      step = found;
      break;
    }
  }
  const intervals = Math.ceil(top / step);
  return { max: intervals * step, ticks: Array.from({ length: intervals + 1 }, (_, i) => i * step) };
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

/**
 * Which fill an interview-status bar takes. Kept here rather than inline in
 * Dashboard.tsx so that a state group the grouping function invents but the
 * table forgets cannot render an unstyled (invisible) bar — an unknown key
 * falls back to the muted tone instead of to no class at all.
 */
const STATE_TONES: Readonly<Record<string, string>> = {
  scheduled: 'tone-accent-soft',
  live: 'tone-hold',
  review: 'tone-spark',
  reviewed: 'tone-pass',
  stopped: 'tone-stop',
  other: 'tone-muted',
};

export function chartTone(stateKey: string): string {
  return STATE_TONES[stateKey] ?? 'tone-muted';
}

/**
 * Corner radius for a bar of the given size.
 *
 * A flat `rx` is what makes an in-house SVG chart look unfinished: at the
 * design radius a one-unit bar is rounded away into a lozenge, and a zero-width
 * bar with a radius still paints a visible stub where the data says nothing is
 * there. Clamping to half the shorter side keeps the corner proportional, and
 * an empty bar gets no radius because it gets no bar.
 */
const BAR_RADIUS = 5;

export function barRadius(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return Math.min(BAR_RADIUS, width / 2, height / 2);
}

/** The raw session states folded into a display group, e.g. 'stopped'. */
export function statesInGroup(key: string): readonly string[] {
  return STATE_GROUPS.find((g) => g.key === key)?.states ?? [];
}

/**
 * Drop the quiet weeks at either end of a series, keeping the quiet ones in
 * between.
 *
 * A rolling twelve-week window is mostly empty for anyone not hiring
 * continuously, and an honest chart of it is nine blank columns and three bars
 * squeezed against one edge. Trimming the ends lets the activity fill the panel
 * at any volume. A gap *between* two active weeks is left alone, because a
 * fortnight when hiring stopped is information; a gap before anyone started is
 * not.
 *
 * An entirely empty series is returned whole, so the chart still has an axis to
 * draw rather than collapsing to nothing.
 */
export function trimSparseWeeks<T extends { created: number; completed: number }>(series: readonly T[]): T[] {
  const active = (d: T) => d.created > 0 || d.completed > 0;
  const first = series.findIndex(active);
  if (first === -1) return [...series];
  let last = series.length - 1;
  while (last > first && !active(series[last])) last -= 1;
  return series.slice(first, last + 1);
}
