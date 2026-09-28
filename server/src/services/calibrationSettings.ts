// Who has calibration on, how hard the evidence bar is, and the kill switches.
//
// Two switches, both of which can only ever make calibration do LESS:
//
//   * The platform switch (config.calibration.enabled, CALIBRATION_ENABLED).
//     Off by default. With it off, observations are still captured — that data
//     is the record of what reviewers decided and is worth keeping whatever the
//     scoring does — but nothing is ever aggregated, activated or applied.
//   * The organisation switch (`calibrationEnabled` in Tenant.policyJson).
//     Off by default. An organisation must choose this.
//
// And one separate, explicit opt-in: `calibrationGlobalContribution`. It is
// asked for on its own, in plain words, and is off unless somebody said yes.

import { config } from '../config.js';
import { parseJsonOptional, prisma } from '../db.js';
import { DEFAULT_CALIBRATION_THRESHOLDS, resolveThresholds, type CalibrationThresholds } from '../domain/calibration.js';

export const CALIBRATION_ENABLED_KEY = 'calibrationEnabled';
export const CALIBRATION_GLOBAL_KEY = 'calibrationGlobalContribution';
export const CALIBRATION_MIN_OBSERVATIONS_KEY = 'calibrationMinObservations';
export const CALIBRATION_MIN_REVIEWERS_KEY = 'calibrationMinReviewers';
export const CALIBRATION_PATTERN_MIN_REVIEWS_KEY = 'calibrationReviewerPatternMinReviews';

/**
 * The words an organisation is shown before it opts in to the shared
 * calibration. They are held here, next to the code that acts on the answer,
 * so the promise and the behaviour cannot drift apart.
 */
export const GLOBAL_CONTRIBUTION_CONSENT = [
  'Share what your reviewers teach us, so every organisation hiring the same role gets a better first draft.',
  'What is shared: the role (as it appears in the shared catalog), the competency, the experience band, the level the AI gave, the level your reviewer gave, and the month. Nothing else.',
  'What is never shared: who the candidate was, who the reviewer was, anything your reviewers wrote in their own words, the interview, the transcript, your scorecard, and your organisation\'s name. Reviewers are counted through a one-way code that is different in every organisation, so the same person cannot be followed between them.',
  'You can turn this off at any time. Turning it off stops any further sharing; what has already been contributed cannot be traced back to you, which is also why it cannot be picked out and withdrawn.',
] as const;

export interface CalibrationSettings {
  /** Both switches on: calibration may aggregate, activate and apply. */
  readonly enabled: boolean;
  readonly platformEnabled: boolean;
  readonly organisationEnabled: boolean;
  readonly contributesGlobally: boolean;
  readonly thresholds: CalibrationThresholds;
}

/** Read straight from a policy blob, for callers that already hold one. */
export function calibrationSettingsFrom(policy: Readonly<Record<string, unknown>>): CalibrationSettings {
  const platformEnabled = config.calibration.enabled;
  const organisationEnabled = policy[CALIBRATION_ENABLED_KEY] === true;
  return {
    platformEnabled,
    organisationEnabled,
    enabled: platformEnabled && organisationEnabled,
    // An organisation that has not switched calibration on cannot be
    // contributing to the shared one either, whatever the flag says.
    contributesGlobally: platformEnabled && organisationEnabled && policy[CALIBRATION_GLOBAL_KEY] === true,
    thresholds: resolveThresholds({
      ...numberFrom(policy, CALIBRATION_MIN_OBSERVATIONS_KEY, 'minObservations'),
      ...numberFrom(policy, CALIBRATION_MIN_REVIEWERS_KEY, 'minReviewers'),
      ...numberFrom(policy, CALIBRATION_PATTERN_MIN_REVIEWS_KEY, 'reviewerPatternMinReviews'),
    }),
  };
}

function numberFrom(
  policy: Readonly<Record<string, unknown>>, key: string, field: keyof CalibrationThresholds,
): Partial<CalibrationThresholds> {
  const value = policy[key];
  return typeof value === 'number' && Number.isFinite(value) ? { [field]: value } : {};
}

export async function calibrationSettingsFor(tenantId: string): Promise<CalibrationSettings> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { policyJson: true } });
  if (!tenant) {
    return {
      enabled: false, platformEnabled: config.calibration.enabled, organisationEnabled: false,
      contributesGlobally: false, thresholds: DEFAULT_CALIBRATION_THRESHOLDS,
    };
  }
  const policy = parseJsonOptional<Record<string, unknown>>(
    tenant.policyJson, {}, { model: 'Tenant', id: tenantId, field: 'policyJson' },
  );
  return calibrationSettingsFrom(policy);
}
