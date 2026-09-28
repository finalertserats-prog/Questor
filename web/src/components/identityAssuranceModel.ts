/**
 * The organisation's identity assurance level in Settings (server
 * domain/identityAssurance.ts). Standard is on for every organisation and is
 * the floor (owner decision 2026-09-22); Enhanced and Verified are listed as
 * coming later and cannot be chosen yet. Tested in
 * web/tests/identityAssuranceModel.test.ts.
 */

export interface AssuranceLevelOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly available: boolean;
}

/** GET /api/admin/identity-assurance */
export interface AssuranceSettingData {
  readonly level: string;
  readonly levels: readonly AssuranceLevelOption[];
}

export function optionLabel(option: AssuranceLevelOption, current: string): string {
  if (!option.available) return `${option.label} (coming later)`;
  return option.id === current ? `${option.label} (current)` : option.label;
}

/** Whether Save does anything: a different level that can actually be chosen. */
export function canSaveLevel(data: AssuranceSettingData, choice: string): boolean {
  return choice !== data.level && data.levels.some((l) => l.id === choice && l.available);
}

export const ASSURANCE_SETTING_NOTE = 'Standard is on for every organisation: each candidate confirms a one-time code sent to their email before the interview, and is asked one or two questions about specifics on their own CV. The results appear on the review page for a person to weigh; they never reject anyone on their own.';
