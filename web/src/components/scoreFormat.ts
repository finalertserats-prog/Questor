/**
 * How a number that may not be there is written down. Kept free of React so it
 * can be unit tested (see web/tests/scoreFormat.test.ts).
 *
 * WHY this is shared rather than inline at each site: `Math.round(x)` on a
 * missing figure renders the literal "NaN" — "NaN/100", "NaN%" — and every
 * page that shows a score had its own copy of that line. A fit result stored
 * before `overall` existed, an assessment whose grading never completed, a
 * tenant with no data yet: all of them reach these call sites.
 */

/** What every screen shows where a number would be if there were one. */
export const NO_SCORE = '—';

/** Is this a number we can actually show? Zero is; NaN, null and "72" are not. */
export function hasScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A score rounded for arithmetic — a meter width, a stored field — or null. */
export function roundScore(value: unknown): number | null {
  return hasScore(value) ? Math.round(value) : null;
}

/** A score as a display string, or a dash when there is none. */
export function formatScore(value: unknown): string {
  return hasScore(value) ? String(Math.round(value)) : NO_SCORE;
}

/** The same score against its scale — "72/100" — and never "NaN/100". */
export function formatScoreOutOf100(value: unknown): string {
  return hasScore(value) ? `${Math.round(value)}/100` : NO_SCORE;
}

/**
 * A 0–1 fraction as a percentage, or a dash.
 *
 * The dash matters: "0%" is a measurement ("no answer had evidence behind
 * it"), and showing it for a figure that has not loaded states something the
 * data does not say.
 */
export function formatPercent(value: unknown): string {
  return hasScore(value) ? `${Math.round(value * 100)}%` : NO_SCORE;
}
