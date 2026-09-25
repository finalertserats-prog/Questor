/**
 * The organisation's switch for the question library, kept free of React so
 * the defaults are tested (web/tests/questionLibraryModel.test.ts).
 *
 * The defaults mirror the server's (server/src/library/orgSettings.ts): off
 * unless chosen, half of the eligible blocks in the trial, and a 30-day
 * no-repeat window. The section is shown only while the deployment has the
 * library on (GET /api/library/status).
 */

export type LibraryMode = 'off' | 'trial' | 'on';

export const DEFAULT_TRIAL_PERCENT = 50;
export const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

export interface LibraryModeOption {
  readonly mode: LibraryMode;
  readonly label: string;
  readonly help: string;
}

export const LIBRARY_MODE_OPTIONS: readonly LibraryModeOption[] = [
  {
    mode: 'off',
    label: 'Off',
    help: 'Interviews ask from the built-in question bank, as they always have.',
  },
  {
    mode: 'trial',
    label: 'Trial',
    help: 'Each interview draws some of its topics from the question library and the rest from the built-in bank, '
      + 'so the two can be compared on the same candidate. The interviewer always asks in its own words.',
  },
  {
    mode: 'on',
    label: 'On',
    help: 'Every topic the library can serve for the role draws on it; anything it cannot serve uses the built-in bank.',
  },
];

export interface LibrarySettingsView {
  readonly mode: LibraryMode;
  readonly trialPercent: number;
  readonly windowDays: number;
}

function isMode(value: unknown): value is LibraryMode {
  return value === 'off' || value === 'trial' || value === 'on';
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** What the server will do for this organisation. Anything it would refuse shows as the default. */
export function librarySettingsOf(policy: Readonly<Record<string, unknown>>): LibrarySettingsView {
  return {
    mode: isMode(policy.questionLibrary) ? policy.questionLibrary : 'off',
    trialPercent: intIn(policy.questionLibraryTrialPercent, 0, 100) ?? DEFAULT_TRIAL_PERCENT,
    windowDays: intIn(policy.questionLibraryWindowDays, 1, MAX_WINDOW_DAYS) ?? DEFAULT_WINDOW_DAYS,
  };
}

/** The body for PUT /api/admin/policy; the server merges it, so only what changed is sent. */
export function libraryModePatch(mode: LibraryMode): { policy: { questionLibrary: LibraryMode } } {
  return { policy: { questionLibrary: mode } };
}

/** Null when the numbers are not ones to send. */
export function libraryNumbersPatch(trialPercent: number, windowDays: number): { policy: { questionLibraryTrialPercent: number; questionLibraryWindowDays: number } } | null {
  if (intIn(trialPercent, 0, 100) === null || intIn(windowDays, 1, MAX_WINDOW_DAYS) === null) return null;
  return { policy: { questionLibraryTrialPercent: trialPercent, questionLibraryWindowDays: windowDays } };
}
