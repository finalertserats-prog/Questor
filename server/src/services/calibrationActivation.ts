// Activation: turning an aggregate into something that is, or is not, applied.
//
// AUTOMATIC, WITHIN HARD LIMITS. The owner asked for calibration that activates
// on its own rather than sitting in a queue nobody works. Everything that makes
// that safe is here:
//
//   * every gate in domain/calibration.ts must pass, and the fairness gate too;
//   * the adjustment is at most one level, and applies only to future
//     assessments of that one role competency at that one band;
//   * every activation writes an audit event, emails the organisation's admins,
//     and appears in the admin view with the evidence behind it;
//   * one action reverts it, and the revert is audited too;
//   * two kill switches, either of which stops everything.
//
// A run is idempotent: it recomputes each group in place. Running it twice
// changes nothing, and running it after new reviews arrive is how a calibration
// updates — including updating itself back to nothing when the evidence
// changes its mind.

import { parseJson, prisma } from '../db.js';
import { logger } from '../logger.js';
import {
  boundDelta, decideActivation,
  type ActivationDecision, type CalibrationAggregate, type CalibrationThresholds, type FairnessCheck,
} from '../domain/calibration.js';
import type { RoleSuccessProfile } from '../domain/types.js';
import { logAudit } from './audit.js';
import { aggregateGroup, clusterReasons, groupsForTenant, type CalibrationGroup, type ReasonTheme } from './calibrationAggregate.js';
import { profileForScorecard } from './calibrationCapture.js';
import { fairnessFor, snapshotsForRole } from './calibrationFairness.js';
import { calibrationSettingsFor } from './calibrationSettings.js';
import { heldOutForCalibration } from './reviewerPatterns.js';
import { proposeAnchorsFrom } from './calibrationAnchors.js';
import { notifyCalibrationAdmins } from './calibrationNotice.js';

export const CALIBRATION_ACTIVATED = 'calibration.activated';
export const CALIBRATION_HELD = 'calibration.held';
export const CALIBRATION_WITHDRAWN = 'calibration.withdrawn';
export const CALIBRATION_REVERTED = 'calibration.reverted';

export interface CalibrationRunResult {
  readonly groups: number;
  readonly activated: number;
  readonly held: number;
  readonly withdrawn: number;
  readonly unchanged: number;
  readonly skipped: string | null;
}

const EMPTY: CalibrationRunResult = { groups: 0, activated: 0, held: 0, withdrawn: 0, unchanged: 0, skipped: null };

/**
 * Recompute every calibration for one organisation.
 *
 * Runs as the system. Never throws: a failure on one group is logged and the
 * rest of the run continues, because one unreadable scorecard must not stop an
 * organisation's calibration from updating.
 */
export async function runCalibration(tenantId: string, now = new Date()): Promise<CalibrationRunResult> {
  const settings = await calibrationSettingsFor(tenantId);
  if (!settings.enabled) {
    // Off is not "do nothing": anything already active must stop applying.
    const withdrawn = await withdrawAll(tenantId, settings.platformEnabled ? 'organisation_switched_off' : 'platform_switched_off');
    return { ...EMPTY, withdrawn, skipped: settings.platformEnabled ? 'organisation_switched_off' : 'platform_switched_off' };
  }

  const thresholds = settings.thresholds;
  const excluded = await heldOutForCalibration(tenantId);
  const groups = await groupsForTenant(tenantId, thresholds, now);
  let activated = 0;
  let held = 0;
  let withdrawn = 0;
  let unchanged = 0;

  for (const group of groups) {
    try {
      const outcome = await runGroup({ group, thresholds, excluded, now });
      if (outcome === 'activated') activated += 1;
      else if (outcome === 'withdrawn') withdrawn += 1;
      else if (outcome === 'held') held += 1;
      else unchanged += 1;
    } catch (err) {
      logger.error({ err: String(err), tenantId, competencyId: group.competencyId }, 'A calibration group could not be recomputed');
    }
  }
  return { groups: groups.length, activated, held, withdrawn, unchanged, skipped: null };
}

type GroupOutcome = 'activated' | 'held' | 'withdrawn' | 'unchanged';

async function runGroup(opts: {
  readonly group: CalibrationGroup;
  readonly thresholds: CalibrationThresholds;
  readonly excluded: readonly string[];
  readonly now: Date;
}): Promise<GroupOutcome> {
  const { group, thresholds, now } = opts;
  const aggregate = await aggregateGroup(group, thresholds, opts.excluded, now);

  const profile = group.scorecardId ? await profileForScorecard(group.scorecardId) : null;
  const competencyName = competencyNameOf(profile, group.competencyId) ?? group.competencyKey;

  // The fairness check is run against the adjustment that WOULD apply, so it
  // answers the question actually being asked.
  const candidateDelta = boundDelta(aggregate.median, thresholds);
  const fairness = candidateDelta === 0
    ? noMovementCheck()
    : await fairnessFor({
        tenantId: group.tenantId,
        roleId: group.roleId,
        competencyId: group.competencyId,
        delta: candidateDelta,
        snapshots: profile
          ? await snapshotsForRole({ tenantId: group.tenantId, roleId: group.roleId, profile, thresholds, now })
          : [],
        thresholds,
      });

  const decision = decideActivation({ aggregate, thresholds, fairness, enabled: true });
  const themes = await themesFor(aggregate, competencyName);

  const previous = await prisma.calibrationAdjustment.findUnique({
    where: {
      scope_tenantId_roleKey_competencyKey_band: {
        scope: 'org', tenantId: group.tenantId, roleKey: group.roleKey,
        competencyKey: group.competencyKey, band: group.band,
      },
    },
  });

  // A reverted adjustment stays reverted until a person says otherwise. The
  // automatic run must not quietly undo a human's decision to switch it off.
  if (previous?.status === 'reverted') {
    await prisma.calibrationAdjustment.update({
      where: { id: previous.id },
      data: { ...measured(aggregate, decision, fairness, themes), status: 'reverted', delta: 0, computedAt: now },
    });
    return 'unchanged';
  }

  const activating = decision.outcome === 'activate';
  const row = await prisma.calibrationAdjustment.upsert({
    where: {
      scope_tenantId_roleKey_competencyKey_band: {
        scope: 'org', tenantId: group.tenantId, roleKey: group.roleKey,
        competencyKey: group.competencyKey, band: group.band,
      },
    },
    create: {
      scope: 'org', tenantId: group.tenantId, roleKey: group.roleKey, roleId: group.roleId,
      competencyKey: group.competencyKey, competencyId: group.competencyId, band: group.band,
      status: activating ? 'active' : 'held',
      delta: decision.delta,
      ...measured(aggregate, decision, fairness, themes),
      computedAt: now,
      activatedAt: activating ? now : null,
    },
    update: {
      status: activating ? 'active' : 'held',
      delta: decision.delta,
      roleId: group.roleId,
      competencyId: group.competencyId,
      ...measured(aggregate, decision, fairness, themes),
      computedAt: now,
      // The date it FIRST started applying, kept across recomputations so the
      // admin view can say how long a role has been scored this way.
      activatedAt: activating ? (previous?.activatedAt ?? now) : null,
    },
  });

  // Where the reasons are about what a strong answer contains, offer the
  // rubric an anchor revision — through the approval path, never silently.
  await proposeAnchorsFrom({
    group, themes, aggregate, competencyName,
  }).catch((err: unknown) => logger.error({ err: String(err) }, 'An anchor proposal could not be written'));

  const wasActive = previous?.status === 'active' && previous.delta !== 0;

  if (activating && (!wasActive || previous?.delta !== decision.delta)) {
    await announce({
      tenantId: group.tenantId, action: CALIBRATION_ACTIVATED, row: row.id, decision, aggregate, fairness,
      competencyName, band: group.band, before: previous, themes,
    });
    return 'activated';
  }
  if (!activating && wasActive) {
    await announce({
      tenantId: group.tenantId, action: CALIBRATION_WITHDRAWN, row: row.id, decision, aggregate, fairness,
      competencyName, band: group.band, before: previous, themes,
    });
    return 'withdrawn';
  }
  if (!activating && !wasActive && previous?.holdReason !== decision.reason) {
    // A change of reason is worth the audit trail but is not worth an email:
    // "still not enough evidence, for a slightly different reason" is noise.
    await logAudit({
      tenantId: group.tenantId, actorType: 'system', action: CALIBRATION_HELD,
      entityType: 'CalibrationAdjustment', entityId: row.id,
      after: { competency: competencyName, band: group.band, reason: decision.reason, statement: decision.statement },
    });
    return 'held';
  }
  return 'unchanged';
}

function measured(
  aggregate: CalibrationAggregate, decision: ActivationDecision, fairness: FairnessCheck, themes: readonly ReasonTheme[],
) {
  return {
    measuredMedian: aggregate.median ?? 0,
    ciLow: aggregate.interval?.low ?? 0,
    ciHigh: aggregate.interval?.high ?? 0,
    ciKnown: aggregate.interval !== null,
    observations: aggregate.observations,
    reviewers: aggregate.reviewers,
    majorDisagreements: aggregate.majorDisagreements,
    sinceAt: aggregate.earliestAt,
    holdReason: decision.reason ?? '',
    statement: decision.statement,
    themesJson: JSON.stringify(themes),
    fairnessJson: JSON.stringify(fairness),
  };
}

/** Nothing would move, so there is nothing to check against the statistics. */
function noMovementCheck(): FairnessCheck {
  return {
    source: 'checked',
    projection: { n: 0, before: null, after: null, shift: null },
    observedPassRate: null,
    observedSample: 0,
    flagged: false,
    statement: 'No adjustment would be applied, so there was nothing to check against the outcome statistics.',
  };
}

async function themesFor(aggregate: CalibrationAggregate, competencyName: string): Promise<ReasonTheme[]> {
  try {
    return await clusterReasons({
      reasons: aggregate.reasons,
      distinctReviewers: aggregate.reviewers,
      competencyName,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, 'Reason themes were unavailable; reporting no summary');
    return [];
  }
}

function competencyNameOf(profile: RoleSuccessProfile | null, competencyId: string): string | null {
  return profile?.competencies.find((c) => c.id === competencyId)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Telling people
// ---------------------------------------------------------------------------

async function announce(opts: {
  readonly tenantId: string;
  readonly action: string;
  readonly row: string;
  readonly decision: ActivationDecision;
  readonly aggregate: CalibrationAggregate;
  readonly fairness: FairnessCheck;
  readonly competencyName: string;
  readonly band: string;
  readonly before: { status: string; delta: number } | null;
  readonly themes: readonly ReasonTheme[];
}): Promise<void> {
  await logAudit({
    tenantId: opts.tenantId,
    actorType: 'system',
    action: opts.action,
    entityType: 'CalibrationAdjustment',
    entityId: opts.row,
    before: opts.before ? { status: opts.before.status, delta: opts.before.delta } : { status: 'none', delta: 0 },
    after: {
      competency: opts.competencyName,
      band: opts.band,
      delta: opts.decision.delta,
      statement: opts.decision.statement,
      observations: opts.aggregate.observations,
      reviewers: opts.aggregate.reviewers,
      interval: opts.aggregate.interval,
      // The fairness check goes in the audit entry in full: an auditor
      // reconstructing why a score moved needs to see what was checked, not
      // only that something was.
      fairness: opts.fairness,
      themes: opts.themes,
    },
  });
  await notifyCalibrationAdmins({
    tenantId: opts.tenantId,
    activated: opts.action === CALIBRATION_ACTIVATED,
    competencyName: opts.competencyName,
    band: opts.band,
    statement: opts.decision.statement,
  });
}

// ---------------------------------------------------------------------------
// Reverting
// ---------------------------------------------------------------------------

export class CalibrationNotFound extends Error {}

/**
 * Switch one calibration off. One action, audited, and it takes effect on the
 * next interview assessed — never on one already assessed, which is the same
 * rule in the other direction.
 */
export async function revertCalibration(opts: {
  readonly tenantId: string;
  readonly adjustmentId: string;
  readonly actorId: string;
  readonly reason: string;
}): Promise<void> {
  const row = await prisma.calibrationAdjustment.findFirst({
    where: { id: opts.adjustmentId, tenantId: opts.tenantId, scope: 'org' },
  });
  if (!row) throw new CalibrationNotFound('That calibration is not one of this organisation\'s.');

  await prisma.calibrationAdjustment.update({
    where: { id: row.id },
    data: {
      status: 'reverted', delta: 0, revertedAt: new Date(), revertedById: opts.actorId, revertReason: opts.reason,
    },
  });
  await logAudit({
    tenantId: opts.tenantId, actorId: opts.actorId, actorType: 'user', action: CALIBRATION_REVERTED,
    entityType: 'CalibrationAdjustment', entityId: row.id,
    before: { status: row.status, delta: row.delta, statement: row.statement },
    after: { status: 'reverted', delta: 0, reason: opts.reason },
  });
}

/** Let an automatic run reconsider a calibration a person switched off. */
export async function restoreCalibration(opts: {
  readonly tenantId: string;
  readonly adjustmentId: string;
  readonly actorId: string;
}): Promise<void> {
  const row = await prisma.calibrationAdjustment.findFirst({
    where: { id: opts.adjustmentId, tenantId: opts.tenantId, scope: 'org', status: 'reverted' },
  });
  if (!row) throw new CalibrationNotFound('That calibration is not one of this organisation\'s reverted ones.');
  // Back to held, never straight to active: it must pass every gate again,
  // on the evidence as it stands now.
  await prisma.calibrationAdjustment.update({
    where: { id: row.id },
    data: { status: 'held', delta: 0, revertedAt: null, revertedById: '', revertReason: '' },
  });
  await logAudit({
    tenantId: opts.tenantId, actorId: opts.actorId, actorType: 'user', action: 'calibration.restored',
    entityType: 'CalibrationAdjustment', entityId: row.id,
    before: { status: 'reverted', reason: row.revertReason },
    after: { status: 'held', note: 'It must meet every threshold again before it applies.' },
  });
}

/** The organisation's kill switch, and what the platform switch does to everyone. */
export async function withdrawAll(tenantId: string, reason: string): Promise<number> {
  const active = await prisma.calibrationAdjustment.findMany({
    where: { tenantId, scope: 'org', status: 'active' }, select: { id: true },
  });
  if (active.length === 0) return 0;
  await prisma.calibrationAdjustment.updateMany({
    where: { tenantId, scope: 'org', status: 'active' },
    data: { status: 'held', delta: 0, holdReason: 'switched_off', statement: 'Calibration is switched off, so nothing is applied.' },
  });
  await logAudit({
    tenantId, actorType: 'system', action: CALIBRATION_WITHDRAWN,
    entityType: 'CalibrationAdjustment', entityId: '',
    after: { reason, count: active.length, ids: active.map((a) => a.id) },
  });
  return active.length;
}

/** Everything an admin view needs, without exposing the raw observations. */
export interface AdjustmentView {
  readonly id: string;
  readonly scope: string;
  readonly roleId: string;
  readonly competencyId: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly status: string;
  readonly delta: number;
  readonly measuredMedian: number;
  readonly interval: { readonly low: number; readonly high: number } | null;
  readonly observations: number;
  readonly reviewers: number;
  readonly majorDisagreements: number;
  readonly since: string | null;
  readonly statement: string;
  readonly holdReason: string;
  readonly themes: readonly ReasonTheme[];
  readonly fairness: unknown;
  readonly activatedAt: string | null;
  readonly revertedAt: string | null;
  readonly revertReason: string;
  readonly computedAt: string;
}

export async function adjustmentsFor(tenantId: string): Promise<AdjustmentView[]> {
  const rows = await prisma.calibrationAdjustment.findMany({
    where: { tenantId, scope: 'org' },
    orderBy: [{ status: 'asc' }, { computedAt: 'desc' }],
    take: 500,
  });
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    roleId: row.roleId,
    competencyId: row.competencyId,
    competencyKey: row.competencyKey,
    band: row.band,
    status: row.status,
    delta: row.delta,
    measuredMedian: row.measuredMedian,
    interval: row.ciKnown ? { low: row.ciLow, high: row.ciHigh } : null,
    observations: row.observations,
    reviewers: row.reviewers,
    majorDisagreements: row.majorDisagreements,
    since: row.sinceAt ? row.sinceAt.toISOString() : null,
    statement: row.statement,
    holdReason: row.holdReason,
    themes: parseJson<ReasonTheme[]>(row.themesJson, []),
    fairness: parseJson<unknown>(row.fairnessJson, {}),
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    revertedAt: row.revertedAt ? row.revertedAt.toISOString() : null,
    revertReason: row.revertReason,
    computedAt: row.computedAt.toISOString(),
  }));
}
