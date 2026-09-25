// The opt-in shared calibration.
//
// WHAT LEAVES AN ORGANISATION, exhaustively:
//   the shared catalog's role id, the competency NAME (lower-cased), the
//   experience band, the level the model gave, the level the reviewer gave,
//   whether the two verdicts agreed, whether the reviewer was blinded, the
//   MONTH, and a one-way reviewer code.
//
// WHAT NEVER LEAVES, also exhaustively:
//   the organisation, the role row, the scorecard, the candidate, the
//   assessment, the interview, the transcript, the evidence, the reviewer's
//   identity, ANY free text a reviewer wrote, and the exact date.
//
// The table's columns are that list (see schema.prisma) — a field that is not
// a column cannot be shared by a mistake in this file.
//
// THE REVIEWER CODE. HMAC(server secret, tenantId + reviewerId), truncated.
// It exists for exactly one reason: the "at least three distinct reviewers"
// rule has to hold in the shared pool too, or one organisation's single
// enthusiastic reviewer could move everybody's scoring. It is salted with the
// tenant, so the same person in two organisations is two unrelated codes and
// nobody can be followed between them; it is keyed with a server secret, so a
// copy of the database cannot be brute-forced back to a user id.

import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import {
  aggregate, boundDelta, decideActivation, isShareableRoleKey, resolveThresholds,
  type CalibrationObservation, type CalibrationThresholds, type FairnessCheck,
} from '../domain/calibration.js';
import { logAudit } from './audit.js';
import { calibrationSettingsFor } from './calibrationSettings.js';
import { windowStart } from './calibrationAggregate.js';

const PSEUDONYM_BYTES = 16;

/**
 * The separator between the parts of a keyed hash. A byte that cannot occur in
 * an id, so ("a", "bc") and ("ab", "c") can never hash to the same value.
 * Written as an escape rather than as the byte itself: a literal NUL in a
 * source file makes git treat it as binary, and a file nobody can diff is a
 * file nobody reviews.
 */
const SEPARATOR = '\u0000';

function keyedHash(...parts: readonly string[]): string {
  return createHmac('sha256', config.authSecret).update(parts.join(SEPARATOR)).digest('hex').slice(0, PSEUDONYM_BYTES * 2);
}

export function reviewerPseudonym(tenantId: string, reviewerId: string): string {
  return keyedHash('calibration-reviewer', tenantId, reviewerId);
}

function sourceHash(tenantId: string, observationId: string): string {
  return keyedHash('calibration-observation', tenantId, observationId);
}

function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Contribute this organisation's shareable observations to the shared pool.
 *
 * Idempotent through `sourceHash`, so it can run as often as it likes. Only
 * catalog-keyed roles are shareable: a role that exists only inside one
 * organisation has no shared meaning and its key would be that organisation's
 * own row id.
 */
export async function contributeGlobalObservations(tenantId: string, now = new Date()): Promise<number> {
  const settings = await calibrationSettingsFor(tenantId);
  if (!settings.contributesGlobally || !config.calibration.globalEnabled) return 0;

  const rows = await prisma.calibrationObservation.findMany({
    where: {
      tenantId,
      delta: { not: null },
      roleKey: { startsWith: 'catalog:' },
      observedAt: { gte: windowStart(settings.thresholds, now) },
    },
    select: {
      id: true, roleKey: true, competencyKey: true, band: true, aiLevel: true, humanLevel: true,
      delta: true, magnitude: true, verdictAgreed: true, blindReview: true, reviewerId: true, observedAt: true,
    },
    take: 5000,
  });

  let written = 0;
  for (const row of rows) {
    if (!isShareableRoleKey(row.roleKey)) continue;
    const hash = sourceHash(tenantId, row.id);
    try {
      await prisma.calibrationGlobalObservation.create({
        data: {
          roleKey: row.roleKey,
          competencyKey: row.competencyKey,
          band: row.band,
          aiLevel: row.aiLevel,
          humanLevel: row.humanLevel,
          delta: row.delta,
          magnitude: row.magnitude,
          verdictAgreed: row.verdictAgreed,
          blindReview: row.blindReview,
          reviewerPseudonym: reviewerPseudonym(tenantId, row.reviewerId),
          observedMonth: monthOf(row.observedAt),
          sourceHash: hash,
        },
      });
      written += 1;
    } catch (err) {
      // P2002: already contributed. Anything else is worth knowing about.
      if ((err as { code?: string }).code !== 'P2002') {
        logger.warn({ err: String(err), tenantId }, 'A calibration observation could not be contributed');
      }
    }
  }
  if (written > 0) {
    await logAudit({
      tenantId, actorType: 'system', action: 'calibration.contributed',
      entityType: 'CalibrationGlobalObservation', entityId: '',
      after: {
        count: written,
        shared: ['roleKey', 'competencyKey', 'band', 'aiLevel', 'humanLevel', 'delta', 'magnitude', 'verdictAgreed', 'blindReview', 'reviewerPseudonym', 'observedMonth'],
        stripped: ['tenantId', 'roleId', 'candidate', 'assessmentId', 'reviewId', 'reviewerId', 'reasonText', 'evidence', 'scorecardId', 'exact date'],
      },
    });
  }
  return written;
}

/**
 * Recompute the shared calibration from the pooled observations.
 *
 * Exactly the same arithmetic and exactly the same gates as an organisation's
 * own, with one difference: the shared pool has no fairness statistics to check
 * against — pass rates are a property of an organisation's hiring, not of a
 * pooled average. So the shared calibration is held to a HIGHER evidence bar
 * instead (three times the observations and twice the reviewers), and each
 * organisation's own calibration overrides it wherever it exists.
 *
 * Platform-operator work, run deliberately. It never emails anybody: no single
 * organisation owns it.
 */
export async function runGlobalCalibration(now = new Date()): Promise<{ groups: number; active: number }> {
  if (!config.calibration.enabled || !config.calibration.globalEnabled) return { groups: 0, active: 0 };
  const base = resolveThresholds({});
  const thresholds: CalibrationThresholds = {
    ...base,
    minObservations: base.minObservations * 3,
    minReviewers: base.minReviewers * 2,
  };

  const allGroups = await prisma.calibrationGlobalObservation.groupBy({
    by: ['roleKey', 'competencyKey', 'band'],
    where: { createdAt: { gte: windowStart(thresholds, now) } },
    _count: { _all: true },
  });
  // Filtered here, not in a `having` clause: see groupsForTenant.
  const groups = allGroups.filter((g) => g._count._all >= thresholds.minObservations);

  let active = 0;
  for (const group of groups) {
    try {
      const rows = await prisma.calibrationGlobalObservation.findMany({
        // The same window the groups were chosen on. Without it, a group that
        // qualified on recent rows was then aggregated over its entire
        // history, so the shared calibration could be decided by evidence the
        // window was meant to have retired.
        where: {
          roleKey: group.roleKey, competencyKey: group.competencyKey, band: group.band,
          createdAt: { gte: windowStart(thresholds, now) },
        },
        orderBy: { createdAt: 'asc' },
        take: 20_000,
      });
      const observations: CalibrationObservation[] = rows.map((r) => ({
        reviewId: r.id,
        // The pseudonym IS the reviewer, for counting purposes and nothing else.
        reviewerId: r.reviewerPseudonym,
        competencyId: '',
        competencyKey: r.competencyKey,
        aiLevel: r.aiLevel,
        humanLevel: r.humanLevel,
        delta: r.delta,
        observedAt: r.createdAt,
        // Never shared, so never available here. The shared calibration has no
        // themes, and the admin view says so rather than inventing any.
        reasonText: '',
        blindReview: r.blindReview,
      }));
      const agg = aggregate({
        roleKey: group.roleKey, competencyKey: group.competencyKey, competencyId: '', band: group.band,
        observations, now, thresholds,
      });
      const decision = decideActivation({ aggregate: agg, thresholds, fairness: NO_STATISTICS, enabled: true });
      const activating = decision.outcome === 'activate';
      await prisma.calibrationAdjustment.upsert({
        where: {
          scope_tenantId_roleKey_competencyKey_band: {
            scope: 'global', tenantId: '', roleKey: group.roleKey, competencyKey: group.competencyKey, band: group.band,
          },
        },
        create: {
          scope: 'global', tenantId: '', roleKey: group.roleKey, competencyKey: group.competencyKey, band: group.band,
          status: activating ? 'active' : 'held', delta: decision.delta, ...measured(agg, decision), computedAt: now,
          activatedAt: activating ? now : null,
        },
        update: {
          status: activating ? 'active' : 'held', delta: decision.delta, ...measured(agg, decision), computedAt: now,
        },
      });
      if (activating) active += 1;
    } catch (err) {
      logger.error({ err: String(err), roleKey: group.roleKey }, 'A shared calibration group could not be recomputed');
    }
  }
  return { groups: groups.length, active };
}

/**
 * The shared pool has no pass rates to check against. Rather than pretend the
 * fairness gate ran, it is recorded as not applicable — and the higher evidence
 * bar above, plus each organisation's own calibration taking precedence, is
 * what stands in its place.
 */
const NO_STATISTICS: FairnessCheck = {
  source: 'checked',
  projection: { n: 0, before: null, after: null, shift: null },
  observedPassRate: null,
  observedSample: 0,
  flagged: false,
  statement: 'The shared calibration has no organisation\'s pass rates to check against; it is held to a higher evidence bar instead, and an organisation\'s own calibration always overrides it.',
};

function measured(agg: ReturnType<typeof aggregate>, decision: ReturnType<typeof decideActivation>) {
  return {
    measuredMedian: agg.median ?? 0,
    ciLow: agg.interval?.low ?? 0,
    ciHigh: agg.interval?.high ?? 0,
    ciKnown: agg.interval !== null,
    observations: agg.observations,
    reviewers: agg.reviewers,
    majorDisagreements: agg.majorDisagreements,
    sinceAt: agg.earliestAt,
    holdReason: decision.reason ?? '',
    statement: decision.statement,
    themesJson: '[]',
    fairnessJson: JSON.stringify(NO_STATISTICS),
  };
}

/** Kept exported so a test can prove the bound holds on the shared pool too. */
export const boundedDelta = boundDelta;
