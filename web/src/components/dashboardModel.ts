/**
 * The dashboard's presentation decisions, kept free of React so they can be
 * unit tested in the node environment (see web/tests/dashboardModel.test.ts).
 */

import { formatDateTime, formatScheduled } from './dateFormat';

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

/** Width of a string as drawn, in CSS pixels. */
export type MeasureText = (text: string) => number;

// An average advance of a proportional UI face, as a share of its size. Used
// only where no canvas is available to measure with (the node tests, SSR).
const AVERAGE_CHAR_WIDTH = 0.58;

/** A rough width for `text` at `fontSize` px when nothing can measure it. */
export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * AVERAGE_CHAR_WIDTH;
}

const ELLIPSIS = '\u2026';

/**
 * `text` shortened with a trailing ellipsis until it measures no wider than
 * `maxWidth`. A label that fits is returned unchanged; with no room for even
 * one character the ellipsis alone is returned, so the row still says
 * "something is here" and the full text lives in the tooltip.
 */
export function truncateToWidth(text: string, maxWidth: number, measure: MeasureText): string {
  if (measure(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid).trimEnd() + ELLIPSIS) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ELLIPSIS : text.slice(0, lo).trimEnd() + ELLIPSIS;
}

/** The longest prefix of `text` (at least one character) that measures within `width`. */
function fittingPrefix(text: string, width: number, measure: MeasureText): number {
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid)) <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * `text` wrapped at spaces into at most `maxLines` lines no wider than
 * `width`. A word longer than a line is broken inside itself; whatever would
 * need a line beyond the last is cut with an ellipsis on the last line.
 */
export function wrapToLines(text: string, width: number, measure: MeasureText, maxLines: number): string[] {
  const lines: string[] = [];
  let rest = text.trim();
  while (rest && lines.length < maxLines - 1 && measure(rest) > width) {
    const words = rest.split(' ');
    let line = '';
    let used = 0;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) > width) break;
      line = candidate;
      used += 1;
    }
    if (!line) {
      const cut = fittingPrefix(rest, width, measure);
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    } else {
      lines.push(line);
      rest = words.slice(used).join(' ');
    }
  }
  return rest ? [...lines, truncateToWidth(rest, width, measure)] : lines;
}

export const BAR_LAYOUT = {
  /** Space between the end of a label and the start of its bar. */
  labelGap: 10,
  /** Space between the end of a bar and its printed value. */
  valueGap: 6,
  /** The label column never takes more than this share of the chart. */
  maxLabelShare: 0.4,
  /** Least space kept between two axis labels. */
  axisLabelGap: 8,
} as const;

/** How a bar chart places its labels: beside the bars, or on a line above each. */
export type BarLayoutMode = 'inline' | 'stacked';

/** Row heights per mode: a stacked row is a label line plus a bar line. */
export const BAR_ROW = { inline: 30, stackedLabel: 18, stackedBar: 22 } as const;
/** A stacked label may take this many lines before it is cut. */
const MAX_LABEL_LINES = 2;

// Room kept between the end of the widest value and the svg's right edge, so
// a number never sits against the card's border.
const VALUE_EDGE_MARGIN = 8;
// Beside-the-bar labels are only worth it while the bars keep this much room.
const MIN_INLINE_PLOT = 80;

export interface HorizontalBarLayout {
  readonly mode: BarLayoutMode;
  /** Width of the label column, gap included; 0 when stacked. Bars start here. */
  readonly labelW: number;
  /** Length of a full-scale bar. */
  readonly plotW: number;
  /** Room reserved to the right of the plot for the widest value and the edge margin. */
  readonly valueW: number;
  /** Height of a one-line row. A stacked row with a wrapped label is taller. */
  readonly rowHeight: number;
  /** Each label as drawn, one entry per line. */
  readonly labelLines: readonly (readonly string[])[];
  /** Where each row starts, in px from the top. */
  readonly rowTops: readonly number[];
  /** Total height of all rows. */
  readonly height: number;
}

function stackRows(lineCounts: readonly number[], rowHeight: number, extraPerLine: number): { rowTops: number[]; height: number } {
  const rowTops: number[] = [];
  let y = 0;
  for (const lines of lineCounts) {
    rowTops.push(y);
    y += rowHeight + (lines - 1) * extraPerLine;
  }
  return { rowTops, height: Math.max(rowHeight, y) };
}

/**
 * Geometry for a horizontal bar chart `width` px wide.
 *
 * Labels sit beside the bars only when every one of them fits a column of at
 * most 40% of the chart with the bars still readable; otherwise each label
 * gets its own line across the full width, above its bar. Nothing is cut
 * short to make the side-by-side layout work: a truncated role title is a
 * title nobody can identify. The value column is sized from the widest value
 * plus an edge margin, so every number ends inside the svg.
 */
export function chooseBarLayout(
  labels: readonly string[],
  values: readonly number[],
  width: number,
  measureLabel: MeasureText,
  measureValue: MeasureText,
): HorizontalBarLayout {
  const safeWidth = Math.max(0, width);
  const longest = Math.max(0, ...labels.map(measureLabel));
  const widestValue = Math.max(0, ...values.map((v) => measureValue(String(v))));
  const valueW = Math.ceil(widestValue + BAR_LAYOUT.valueGap + VALUE_EDGE_MARGIN);
  const inlineLabelW = Math.ceil(longest + BAR_LAYOUT.labelGap);
  const fitsInline = inlineLabelW <= Math.floor(safeWidth * BAR_LAYOUT.maxLabelShare)
    && safeWidth - inlineLabelW - valueW >= MIN_INLINE_PLOT;
  if (fitsInline) {
    return {
      mode: 'inline', labelW: inlineLabelW, plotW: safeWidth - inlineLabelW - valueW, valueW,
      rowHeight: BAR_ROW.inline, labelLines: labels.map((l) => [l]),
      ...stackRows(labels.map(() => 1), BAR_ROW.inline, 0),
    };
  }
  const labelLines = labels.map((l) => wrapToLines(l, safeWidth, measureLabel, MAX_LABEL_LINES));
  const rowHeight = BAR_ROW.stackedLabel + BAR_ROW.stackedBar;
  return {
    mode: 'stacked', labelW: 0, plotW: Math.max(0, safeWidth - valueW), valueW, rowHeight, labelLines,
    ...stackRows(labelLines.map((lines) => lines.length), rowHeight, BAR_ROW.stackedLabel),
  };
}

/**
 * Label every n-th slot of a column chart so that labels `labelWidth` px wide
 * never overlap. Measured, not guessed from the slot alone: a phone fits far
 * fewer "12 Sep"s across than a desktop does.
 */
export function axisLabelStride(slotWidth: number, labelWidth: number): number {
  if (labelWidth <= 0) return 1;
  if (slotWidth <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.ceil((labelWidth + BAR_LAYOUT.axisLabelGap) / slotWidth));
}

export interface RecentInterviewDates {
  readonly createdAt: string;
  readonly scheduledAt: string | null;
  readonly scheduledTimeZone: string | null;
  readonly completedAt: string | null;
}

/**
 * The date that matters most for where an interview is in its life, written
 * down. A booked time is on the clock it was booked on (else the
 * organisation's), never the viewer's alone; the other dates name their zone.
 */
export function recentInterviewDate(
  row: RecentInterviewDates,
  orgZone: string | null | undefined,
  viewerZone?: string,
): { readonly label: string; readonly text: string } {
  if (row.completedAt) return { label: 'Completed', text: formatDateTime(row.completedAt) };
  if (row.scheduledAt) return { label: 'Scheduled', text: formatScheduled(row.scheduledAt, row.scheduledTimeZone, orgZone, viewerZone) };
  return { label: 'Created', text: formatDateTime(row.createdAt) };
}

/** A centred label's x, moved in so a `labelWidth` label stays inside [0, width]. */
export function clampLabelCenter(center: number, labelWidth: number, width: number): number {
  const half = labelWidth / 2;
  return Math.min(Math.max(center, half), Math.max(half, width - half));
}
