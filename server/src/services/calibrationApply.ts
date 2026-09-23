// The read side: what the evaluator is handed before it grades an interview.
//
// FORWARD ONLY LIVES HERE. This is the ONLY way a calibration reaches a score,
// and it is called once, at the moment an interview is being assessed. There is
// no path from an adjustment to an assessment that already exists: nothing in
// this file takes an assessment id, and nothing writes.
//
// Precedence: the organisation's own calibration wins over the shared one. An
// organisation that has learned something about its own role knows more about
// it than the pooled average does, and the shared calibration exists to help
// before you have enough of your own.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import {
  DEFAULT_CALIBRATION_THRESHOLDS, boundDelta, competencyKeyOf, describeProvenance, roleKeyOf,
  type CalibrationMap, type CalibrationProvenance, type CompetencyCalibration,
} from '../domain/calibration.js';
import type { Competency } from '../domain/types.js';
import { calibrationSettingsFor } from './calibrationSettings.js';

const ACTIVE = 'active';

/**
 * How stale an adjustment may be before it stops applying.
 *
 * The recompute runs daily, so anything this old means the job has not run:
 * the deployment switch was off for a month, the job died, or the database was
 * restored from a backup. In each case the adjustment describes evidence
 * nobody has checked recently, and it would start applying again the moment
 * the switch came back on, before anything re-examined it.
 *
 * Generous on purpose. It is a guard against a stopped world, not a second
 * freshness policy — thirty days of a daily job failing is an outage, and an
 * outage should not quietly keep moving candidates' scores.
 */
const MAX_AGE_DAYS = 30;

export interface CalibrationLookup {
  readonly tenantId: string;
  readonly roleId: string;
  readonly catalogRoleId: string | null;
  readonly band: string;
  readonly competencies: readonly Pick<Competency, 'id' | 'name'>[];
}

/**
 * The active adjustments for this interview's role, competencies and band.
 *
 * Empty whenever anything is off, missing or unreadable. An empty map makes
 * `evaluate()` behave byte-for-byte as it did before calibration existed, so
 * the failure mode of this whole feature is "the product as it was".
 */
export async function calibrationFor(lookup: CalibrationLookup): Promise<CalibrationMap> {
  try {
    const settings = await calibrationSettingsFor(lookup.tenantId);
    if (!settings.enabled) return {};
    return await load(lookup, settings.contributesGlobally);
  } catch (err) {
    logger.error({ err: String(err), roleId: lookup.roleId }, 'Calibration could not be read; this interview is scored uncalibrated');
    return {};
  }
}

async function load(lookup: CalibrationLookup, mayUseGlobal: boolean): Promise<CalibrationMap> {
  const roleKey = roleKeyOf({ catalogRoleId: lookup.catalogRoleId, roleId: lookup.roleId });
  const keys = lookup.competencies.map((c) => competencyKeyOf(c.name));
  if (keys.length === 0) return {};

  const freshSince = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.calibrationAdjustment.findMany({
    where: {
      status: ACTIVE,
      computedAt: { gte: freshSince },
      roleKey,
      band: lookup.band,
      competencyKey: { in: keys },
      OR: [
        { scope: 'org', tenantId: lookup.tenantId },
        // The shared calibration only reaches an organisation that contributes
        // to it. Taking without giving would let one organisation's reviewers
        // shape everyone's scoring while learning nothing from anyone.
        ...(mayUseGlobal ? [{ scope: 'global' as const }] : []),
      ],
    },
  });
  if (rows.length === 0) return {};

  const map: Record<string, CompetencyCalibration> = {};
  for (const competency of lookup.competencies) {
    const key = competencyKeyOf(competency.name);
    const own = rows.find((r) => r.scope === 'org' && r.competencyKey === key);
    const shared = rows.find((r) => r.scope === 'global' && r.competencyKey === key);
    const row = own ?? shared;
    if (!row) continue;
    // The bound is enforced AGAIN here, at the last point before a stored
    // number becomes a score. Every writer already bounds it; this is the one
    // that holds if a writer is wrong, a migration is wrong, or somebody edits
    // the row by hand. The promise is "at most one level" — not "at most one
    // level as long as every other file is correct".
    const delta = boundDelta(row.delta, DEFAULT_CALIBRATION_THRESHOLDS);
    if (delta === 0) continue;
    if (delta !== row.delta) {
      logger.error(
        { adjustmentId: row.id, stored: row.delta, applied: delta },
        'A stored calibration was outside the permitted bound and was clamped before it reached a score',
      );
    }
    map[competency.id] = {
      delta,
      provenance: { ...provenanceOf(row), delta },
    };
  }
  return map;
}

interface AdjustmentRow {
  readonly id: string;
  readonly scope: string;
  readonly delta: number;
  readonly observations: number;
  readonly reviewers: number;
  readonly sinceAt: Date | null;
  readonly statement: string;
}

function provenanceOf(row: AdjustmentRow): CalibrationProvenance {
  const since = row.sinceAt ? row.sinceAt.toISOString() : '';
  const statement = row.statement || `Adjusted ${row.delta > 0 ? '+' : ''}${row.delta}: ${describeProvenance({
    observations: row.observations, reviewers: row.reviewers, earliestAt: row.sinceAt,
  })}.`;
  return {
    adjustmentId: row.id,
    scope: row.scope === 'global' ? 'global' : 'org',
    delta: row.delta,
    observations: row.observations,
    reviewers: row.reviewers,
    since,
    statement,
  };
}
