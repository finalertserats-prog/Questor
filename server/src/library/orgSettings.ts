import { DEFAULT_TRIAL_PERCENT, type LibraryMode } from './planLadders.js';

/**
 * An organisation's switch for the Q&A library, from its Hiring policy
 * (Tenant.policyJson). The deployment's LIBRARY_ENABLED is the kill switch
 * above it: with that off, none of this is read.
 *
 *   questionLibrary             'off' | 'trial' | 'on'
 *   questionLibraryTrialPercent share of eligible blocks drawn from the library in trial (default 50)
 *   questionLibraryWindowDays   no-repeat window per role in this organisation (default 30)
 *
 * Unset means off for an organisation and the interleaved trial for the demo
 * sandbox, which is where the plan starts the trial.
 */

export const LIBRARY_MODES = ['off', 'trial', 'on'] as const satisfies readonly LibraryMode[];
export const MAX_WINDOW_DAYS = 365;

export interface OrgLibrarySettings {
  readonly mode: LibraryMode;
  readonly trialPercent: number;
  readonly windowDays: number;
}

function isMode(value: unknown): value is LibraryMode {
  return typeof value === 'string' && (LIBRARY_MODES as readonly string[]).includes(value);
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function orgLibrarySettings(policy: Readonly<Record<string, unknown>>, opts: { readonly isDemo: boolean; readonly defaultWindowDays: number }): OrgLibrarySettings {
  return {
    mode: isMode(policy.questionLibrary) ? policy.questionLibrary : opts.isDemo ? 'trial' : 'off',
    trialPercent: intIn(policy.questionLibraryTrialPercent, 0, 100) ?? DEFAULT_TRIAL_PERCENT,
    windowDays: intIn(policy.questionLibraryWindowDays, 1, MAX_WINDOW_DAYS) ?? opts.defaultWindowDays,
  };
}
