// The automatic run.
//
// The owner asked for calibration that activates on its own rather than sitting
// in a queue nobody works. This is the thing that makes it automatic: a leased
// background job that recomputes every organisation's calibration, refreshes
// the reviewer-pattern alerts, and contributes to the shared pool where an
// organisation has opted in.
//
// Nothing it does is irreversible and nothing it does is silent: every
// activation is audited, emails the organisation's admins, and can be reverted
// in one action (services/calibrationActivation.ts).
//
// Daily, not hourly. A calibration that moved between the morning and the
// afternoon would be impossible for anybody to reason about, and the evidence
// it reads does not change that fast.

import { config } from '../config.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { startJob, type LeaseHandle } from './jobs.js';
import { runCalibration } from './calibrationActivation.js';
import { contributeGlobalObservations, runGlobalCalibration } from './calibrationGlobal.js';
import { refreshPatternAlerts } from './reviewerPatterns.js';
import { calibrationSettingsFor } from './calibrationSettings.js';

export const CALIBRATION_JOB = {
  name: 'role-calibration',
  intervalMs: 24 * 60 * 60_000,
  ttlMs: 30 * 60_000,
} as const;

const TENANTS_PER_RUN = 200;

export async function runCalibrationSweep(lease: LeaseHandle | null = null, now: Date = new Date()): Promise<string> {
  if (!config.calibration.enabled) return 'calibration is switched off for this deployment; nothing was recomputed';

  const tenants = await prisma.tenant.findMany({
    where: { isDemo: false },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: TENANTS_PER_RUN,
  });

  let activated = 0;
  let held = 0;
  let withdrawn = 0;
  let contributed = 0;
  let alerts = 0;

  for (const tenant of tenants) {
    if (lease && !(await lease.renew(CALIBRATION_JOB.ttlMs))) break;
    try {
      const settings = await calibrationSettingsFor(tenant.id);
      if (!settings.organisationEnabled) continue;

      // Patterns first: a reviewer held out of calibration must be held out of
      // THIS run, not the next one.
      const refreshed = await refreshPatternAlerts(tenant.id, now);
      alerts += refreshed.opened;

      const result = await runCalibration(tenant.id, now);
      activated += result.activated;
      held += result.held;
      withdrawn += result.withdrawn;

      if (settings.contributesGlobally) {
        contributed += await contributeGlobalObservations(tenant.id, now);
      }
    } catch (err) {
      // One organisation's failure must not stop the rest of the sweep.
      logger.error({ err: String(err), tenantId: tenant.id }, 'Calibration could not be recomputed for this organisation');
    }
  }

  if (config.calibration.globalEnabled) {
    try {
      await runGlobalCalibration(now);
    } catch (err) {
      logger.error({ err: String(err) }, 'The shared calibration could not be recomputed');
    }
  }

  return `calibration: ${activated} activated, ${withdrawn} withdrawn, ${held} held, ${alerts} patterns raised, ${contributed} observations contributed`;
}

export function startCalibrationJob(): (() => void) | null {
  if (!config.calibration.enabled) return null;
  return startJob({ ...CALIBRATION_JOB, delayFirst: true, fn: (lease) => runCalibrationSweep(lease) });
}
