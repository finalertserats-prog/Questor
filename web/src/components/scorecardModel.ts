/**
 * The rules behind editing a role's scorecard on the page. Kept free of React
 * so they can be unit tested in the node environment this workspace uses.
 *
 * Units, because they have already bitten: competency weights are fractions
 * (0..1) and the page shows them as percentages, but the pass threshold is
 * stored as whole points out of 100 (server/src/domain/types.ts). Treating the
 * threshold like a weight is how HR came to see "Pass threshold: 6500%".
 */

export const PASS_THRESHOLD_MIN = 0;
export const PASS_THRESHOLD_MAX = 100;

export const RED_FLAG_MAX_LENGTH = 160;
export const RED_FLAG_MAX_COUNT = 20;

/** A threshold stored as points out of 100, shown as that percentage. */
export function formatPassThreshold(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return `${clampPassThreshold(value)}%`;
}

/** What a typed threshold becomes: a whole number of points, 0 to 100. */
export function clampPassThreshold(raw: number): number {
  if (Number.isNaN(raw)) return PASS_THRESHOLD_MIN;
  return Math.min(PASS_THRESHOLD_MAX, Math.max(PASS_THRESHOLD_MIN, Math.round(raw)));
}

/** A flag as it will be stored: trimmed, single-spaced. */
function normaliseRedFlag(text: string): string {
  return text.trim().split(/\s+/).join(' ');
}

/**
 * Why a flag cannot be added, as a sentence, or null when it can. Written for
 * the page to show next to the input, so the reason is specific.
 */
export function redFlagProblem(flags: readonly string[], text: string): string | null {
  const flag = normaliseRedFlag(text);
  if (!flag) return 'Type the red flag first.';
  if (flag.length > RED_FLAG_MAX_LENGTH) return `Keep a red flag under ${RED_FLAG_MAX_LENGTH} characters.`;
  if (flags.length >= RED_FLAG_MAX_COUNT) return `A scorecard holds at most ${RED_FLAG_MAX_COUNT} red flags.`;
  const lower = flag.toLowerCase();
  if (flags.some((existing) => existing.toLowerCase() === lower)) return 'That red flag is already on the list.';
  return null;
}

/** The list with the flag added, or the same list if it cannot be. */
export function addRedFlag(flags: readonly string[], text: string): readonly string[] {
  if (redFlagProblem(flags, text)) return flags;
  return [...flags, normaliseRedFlag(text)];
}

/** The list without the flag at that position. */
export function removeRedFlag(flags: readonly string[], index: number): readonly string[] {
  if (index < 0 || index >= flags.length) return flags;
  return flags.filter((_, i) => i !== index);
}
