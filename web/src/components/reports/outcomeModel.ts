/**
 * The Reports page's decisions, kept free of React so they can be unit tested
 * (web/tests/outcomeModel.test.ts).
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE. A percentage never appears alone. It
 * arrives with the counts it was computed from, and below the minimum sample it
 * arrives with a sentence saying it must not be read. There is deliberately no
 * function here that returns a bare percentage string for display — `percent`
 * is a formatter the readers below compose, never a way around `readRate`.
 */

// ---------------------------------------------------------------------------
// The server's shapes, as this page reads them
// ---------------------------------------------------------------------------

export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
  readonly readable: boolean;
}

export interface Quantiles {
  readonly n: number;
  readonly median: number | null;
  readonly q1: number | null;
  readonly q3: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly readable: boolean;
}

export interface FunnelStep {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly basis: string | null;
  readonly ofBasis: Rate | null;
  readonly ofInvited: Rate | null;
}

export type VerdictKey = 'PROCEED' | 'CONSIDER' | 'DO_NOT_PROGRESS';

export interface CutGroup {
  readonly key: string;
  readonly label: string;
  readonly n: number;
  readonly started: Rate;
  readonly completed: Rate;
  readonly assessed: Rate;
  readonly humanReviewed: Rate;
  readonly aiVerdicts: Readonly<Record<VerdictKey, Rate>>;
  readonly humanVerdicts: Readonly<Record<VerdictKey, Rate>>;
  readonly hired: Rate;
  readonly score: Quantiles;
  readonly readable: boolean;
}

export interface LevelCount {
  readonly level: number;
  readonly count: number;
}

export interface ScoreBucket {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Reading a rate
// ---------------------------------------------------------------------------

/**
 * A proportion as a percentage. Below one per cent it keeps a decimal place:
 * rounding 0.4% to "0%" would turn a real rate into "never happens".
 */
export function percent(value: number | null): string {
  if (value === null) return '—';
  const asPercent = value * 100;
  return asPercent > 0 && asPercent < 1 ? `${Math.round(asPercent * 10) / 10}%` : `${Math.round(asPercent)}%`;
}

export interface ReadRate {
  readonly percent: string;
  readonly counts: string;
  readonly readable: boolean;
  /** Empty when the sample is large enough; otherwise the sentence that must be shown with it. */
  readonly note: string;
}

/**
 * A rate, said in full.
 *
 * "Nothing measured" and "zero per cent" are different facts and read
 * differently here: a denominator of zero is the absence of a measurement, and
 * showing it as 0% would be a claim nobody made.
 */
export function readRate(rate: Rate | null | undefined, minSample: number): ReadRate {
  if (!rate || rate.denominator === 0) {
    return { percent: '—', counts: 'nothing measured', readable: false, note: '' };
  }
  return {
    percent: percent(rate.value),
    counts: `${rate.numerator} of ${rate.denominator}`,
    readable: rate.readable,
    note: rate.readable ? '' : tooSmallNote(minSample),
  };
}

export function tooSmallNote(minSample: number): string {
  return `Too few to read — a rate needs at least ${minSample}.`;
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

export interface RateBar {
  readonly key: string;
  readonly label: string;
  /** 0..1, the length the bar is drawn at. */
  readonly value: number;
  readonly percent: string;
  readonly counts: string;
  readonly readable: boolean;
  readonly note: string;
}

/**
 * The funnel as nested bars.
 *
 * Each bar's LENGTH is its share of everyone invited, so the steps nest inside
 * one another and the drop between them is the thing you see. Each bar's
 * PERCENTAGE is its share of the step it came from, because that is the
 * question being asked of it ("of the people who started, how many finished?").
 * Two different numbers, so both are printed rather than either being inferred
 * from the drawing.
 */
export function funnelBars(funnel: readonly FunnelStep[], minSample: number): RateBar[] {
  return funnel.map((step): RateBar => {
    if (step.basis === null) {
      return { key: step.key, label: step.label, value: 1, percent: '', counts: String(step.count), readable: true, note: '' };
    }
    const read = readRate(step.ofBasis, minSample);
    return {
      key: step.key,
      label: step.label,
      value: step.ofInvited?.value ?? 0,
      percent: read.percent,
      counts: `${step.count} of ${step.ofBasis?.denominator ?? 0} ${step.basis === 'invited' ? 'invited' : basisWord(step.basis)}`,
      readable: read.readable,
      note: read.note,
    };
  });
}

const BASIS_WORDS: Readonly<Record<string, string>> = {
  invited: 'invited',
  started: 'started',
  completed: 'completed',
  assessed: 'assessed',
  humanReviewed: 'reviewed',
  proceed: 'told to proceed',
};

function basisWord(basis: string): string {
  return BASIS_WORDS[basis] ?? basis;
}

export const CUT_MEASURES = [
  { key: 'completed', label: 'Completed', of: 'interviews' },
  { key: 'humanReviewed', label: 'Reviewed by a person', of: 'interviews' },
  { key: 'proceed', label: 'Proceed', of: 'reviews' },
  { key: 'doNotProgress', label: 'Do not progress', of: 'reviews' },
  { key: 'hired', label: 'Hired', of: 'interviews' },
] as const;

export type CutMeasureKey = (typeof CUT_MEASURES)[number]['key'];

/** The rate a measure names on a group. Verdicts divide by the reviews, not by the interviews. */
export function measureRate(group: CutGroup, measure: CutMeasureKey): Rate {
  switch (measure) {
    case 'completed': return group.completed;
    case 'humanReviewed': return group.humanReviewed;
    case 'proceed': return group.humanVerdicts.PROCEED;
    case 'doNotProgress': return group.humanVerdicts.DO_NOT_PROGRESS;
    case 'hired': return group.hired;
  }
}

/** One bar per group, each carrying its own sample size. */
export function cutBars(groups: readonly CutGroup[], measure: CutMeasureKey, minSample: number): RateBar[] {
  return groups.map((group): RateBar => {
    const rate = measureRate(group, measure);
    const read = readRate(rate, minSample);
    return {
      key: group.key,
      label: group.label,
      value: rate.value ?? 0,
      percent: read.percent,
      counts: read.counts,
      readable: read.readable,
      note: read.note,
    };
  });
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

export interface CountColumn {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export function scoreColumns(buckets: readonly ScoreBucket[]): CountColumn[] {
  return buckets.map((bucket) => ({ key: `${bucket.from}-${bucket.to}`, label: `${bucket.from}–${bucket.to}`, count: bucket.count }));
}

/**
 * Levels as columns, including the ones nobody was given. A missing column
 * would close a gap that is itself a fact about the cohort.
 */
export function levelColumns(counts: readonly LevelCount[]): CountColumn[] {
  return counts.map((count) => ({ key: String(count.level), label: `Level ${count.level}`, count: count.count }));
}

/** The spread in words — median and the middle half, never a bare average. */
export function spreadSentence(spread: Quantiles, unit: string): string {
  if (spread.n === 0 || spread.median === null) return 'Nothing measured in this period.';
  const head = `Median ${spread.median}${unit}, middle half ${spread.q1}${unit} to ${spread.q3}${unit}, over ${spread.n} interview${spread.n === 1 ? '' : 's'}.`;
  return spread.readable ? head : `${head} That is too few interviews to read the spread from.`;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM' read as a month. Anything else is handed back unchanged rather than guessed at. */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const index = Number(match[2]) - 1;
  return index >= 0 && index < 12 ? `${MONTHS[index]} ${match[1]}` : month;
}

export const PERIOD_PRESETS = [
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: '180d', label: 'Last 6 months', days: 180 },
  { key: '365d', label: 'Last 12 months', days: 365 },
  { key: 'all', label: 'Everything kept', days: null },
] as const;

export type PeriodKey = (typeof PERIOD_PRESETS)[number]['key'];

/** The range a preset asks for, or null for "everything the server still holds". */
export function periodRange(key: PeriodKey, now: Date): { from: Date; to: Date } | null {
  const preset = PERIOD_PRESETS.find((p) => p.key === key);
  if (!preset || preset.days === null) return null;
  return { from: new Date(now.getTime() - preset.days * 24 * 3_600_000), to: now };
}
