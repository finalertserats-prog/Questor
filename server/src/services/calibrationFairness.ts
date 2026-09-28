// The fairness gate, and the defensive read of the outcome statistics.
//
// WHAT THIS CAN AND CANNOT DO — say it plainly, because the docs must and the
// code should not claim more than the docs:
//
//   It CANNOT detect bias. Nothing in this product can. It has no protected
//   characteristics to test against, deliberately — collecting them to check
//   for bias would be collecting them, which is its own harm and its own legal
//   problem — and an adjustment learned from biased reviews looks exactly like
//   one learned from good ones.
//
//   It CAN refuse to let an adjustment visibly move who gets through a role
//   without a person being told. That is the failure worth catching: the
//   bounded, gradual drift nobody notices because each step was small.
//
// The outcome statistics are owned by another lane (services/outcomeStats.ts,
// the Admin analytics tab). This module reads them through a guarded dynamic
// import and duck-types what comes back: that lane owns its own shape and is
// free to change it, and a rename there must degrade this check rather than
// break scoring. When the statistics cannot be read at all, the gate fails
// CLOSED — "we could not check" is not "the check passed".

import { config } from '../config.js';
import { parseJson, prisma } from '../db.js';
import { logger } from '../logger.js';
import {
  evaluateFairness, projectPassRate,
  type AssessmentSnapshot, type CalibrationThresholds, type FairnessCheck,
} from '../domain/calibration.js';
import type { AssessmentResult, RoleSuccessProfile } from '../domain/types.js';
import { windowStart } from './calibrationAggregate.js';

/**
 * Past assessments on this role, reduced to levels and weights.
 *
 * READ ONLY, and it matters: this is the replay behind the fairness gate, and
 * the whole design promise is that a recorded assessment is never rewritten.
 * Nothing in this file writes to AssessmentVersion.
 */
export async function snapshotsForRole(
  opts: {
    readonly tenantId: string;
    readonly roleId: string;
    readonly profile: RoleSuccessProfile;
    readonly thresholds: CalibrationThresholds;
    readonly now: Date;
  },
): Promise<AssessmentSnapshot[]> {
  const rows = await prisma.assessmentVersion.findMany({
    where: {
      session: { tenantId: opts.tenantId, roleId: opts.roleId },
      createdAt: { gte: windowStart(opts.thresholds, opts.now) },
    },
    select: { id: true, resultJson: true },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  });
  const weights = new Map(opts.profile.competencies.map((c) => [c.id, c.weight]));
  const passThreshold = opts.profile.scoringRules?.passThreshold ?? 70;

  const snapshots: AssessmentSnapshot[] = [];
  for (const row of rows) {
    const result = parseJson<AssessmentResult | null>(row.resultJson, null);
    if (!result || !Array.isArray(result.competencies)) continue;
    snapshots.push({
      assessmentId: row.id,
      passThreshold,
      competencies: result.competencies.map((c) => ({
        id: c.id,
        // The AI's OWN level. Replaying a calibration on top of a level that
        // was itself calibrated would compound the adjustment and measure the
        // wrong thing entirely.
        level: c.level,
        weight: weights.get(c.id) ?? 0,
        notEnoughEvidence: c.notEnoughEvidence === true,
      })),
    });
  }
  return snapshots;
}

/** What the outcome statistics said, or that they were not there to ask. */
export interface OutcomeReading {
  readonly available: boolean;
  readonly readable: boolean;
  readonly passRate: number | null;
  readonly sample: number;
}

const UNAVAILABLE: OutcomeReading = { available: false, readable: false, passRate: null, sample: 0 };

/** The outcome-statistics lane's modules, resolved at run time (see readOutcomeStatistics). */
const OUTCOME_STATS_MODULE = './outcomeStats.js';
const OUTCOME_DOMAIN_MODULE = '../domain/outcomeStats.js';

/**
 * The role's observed pass rate from the outcome-statistics lane.
 *
 * Every step is guarded: the module may not exist, may not export what is
 * expected, may throw, or may answer that its own sample is too small to read.
 * Each of those is reported honestly rather than smoothed into a number.
 */
export async function readOutcomeStatistics(opts: {
  readonly tenantId: string;
  readonly roleId: string;
}): Promise<OutcomeReading> {
  try {
    // The specifier is held in a variable ON PURPOSE, so this file compiles
    // whether or not that lane's module is present — the two are meant to ship
    // independently, and a missing module must degrade the check, not the build.
    const specifier = OUTCOME_STATS_MODULE;
    const module: Record<string, unknown> | null = await import(specifier).catch(() => null);
    if (!module) return UNAVAILABLE;
    const gather = module.gatherOutcomeRows;
    if (typeof gather !== 'function') return UNAVAILABLE;

    // The lane's own gather takes the caller's auth claims and scopes the query
    // by them. Calibration runs as the system over one organisation, so it is
    // handed a tenant-wide claim for that organisation and no other.
    const gathered = await (gather as (auth: unknown, options: unknown) => Promise<unknown>)(
      { tenantId: opts.tenantId, userId: 'system', role: 'admin', email: '' },
      { roleId: opts.roleId },
    );
    const rows = readRows(gathered);
    if (rows === null) return UNAVAILABLE;

    const assessed = rows.filter((r) => r.assessed);
    if (assessed.length === 0) return { available: true, readable: false, passRate: null, sample: 0 };
    const passed = assessed.filter((r) => (r.humanVerdict ?? r.aiVerdict) === 'PROCEED').length;
    const minSample = await readMinSample();
    return {
      available: true,
      readable: assessed.length >= minSample,
      passRate: Math.round((passed / assessed.length) * 10000) / 10000,
      sample: assessed.length,
    };
  } catch (err) {
    logger.warn({ err: String(err), roleId: opts.roleId }, 'Outcome statistics could not be read for the calibration fairness check');
    return UNAVAILABLE;
  }
}

interface OutcomeRowish {
  readonly assessed: boolean;
  readonly aiVerdict: string | null;
  readonly humanVerdict: string | null;
}

/** Duck-typed on purpose: the other lane owns that shape and may change it. */
function readRows(gathered: unknown): OutcomeRowish[] | null {
  const rows = Array.isArray(gathered) ? gathered : (gathered as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return null;
  const out: OutcomeRowish[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.assessed !== 'boolean') return null;
    out.push({
      assessed: r.assessed,
      aiVerdict: typeof r.aiVerdict === 'string' ? r.aiVerdict : null,
      humanVerdict: typeof r.humanVerdict === 'string' ? r.humanVerdict : null,
    });
  }
  return out;
}

/**
 * The other lane's own minimum readable sample.
 *
 * Read from that lane rather than copied, so the two cannot come to disagree
 * about how small is too small to say anything. Falls back to its published
 * value of 20 when the module is not there to ask.
 */
async function readMinSample(): Promise<number> {
  const specifier = OUTCOME_DOMAIN_MODULE;
  const domain: Record<string, unknown> | null = await import(specifier).catch(() => null);
  const value = domain?.OUTCOME_MIN_SAMPLE;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 20;
}

/** The whole gate: replay the adjustment, then check it against the statistics. */
export async function fairnessFor(opts: {
  readonly tenantId: string;
  readonly roleId: string;
  readonly competencyId: string;
  readonly delta: number;
  readonly snapshots: readonly AssessmentSnapshot[];
  readonly thresholds: CalibrationThresholds;
}): Promise<FairnessCheck> {
  const projection = projectPassRate(opts.snapshots, opts.competencyId, opts.delta);
  const reading = await readOutcomeStatistics({ tenantId: opts.tenantId, roleId: opts.roleId });
  return evaluateFairness({
    projection,
    observedPassRate: reading.passRate,
    observedSample: reading.sample,
    statisticsAvailable: reading.available,
    statisticsReadable: reading.readable,
    thresholds: opts.thresholds,
    requireStatistics: config.calibration.requireFairnessCheck,
  });
}
