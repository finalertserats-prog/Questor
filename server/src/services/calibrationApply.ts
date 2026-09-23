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
  competencyKeyOf, describeProvenance, roleKeyOf,
  type CalibrationMap, type CalibrationProvenance, type CompetencyCalibration,
} from '../domain/calibration.js';
import type { Competency } from '../domain/types.js';
import { calibrationSettingsFor } from './calibrationSettings.js';

const ACTIVE = 'active';

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

  const rows = await prisma.calibrationAdjustment.findMany({
    where: {
      status: ACTIVE,
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
    if (!row || row.delta === 0) continue;
    map[competency.id] = {
      delta: row.delta,
      provenance: provenanceOf(row),
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
