// Reviewer patterns: the database around domain/reviewerPatterns.ts.
//
// This is employee data. Three rules follow from that and are implemented here
// rather than promised in a document:
//
//   1. Only the organisation's admin may read another person's figures
//      (`admin:manage`), and every such read is audited.
//   2. Every reviewer may read their own, with no capability at all, and they
//      are the SAME numbers the admin sees — not a softened version.
//   3. Nothing is DONE TO a reviewer automatically. The one automatic effect
//      is that their observations stop feeding calibration while an alert is
//      open — a brake on what the model learns, not a sanction on the person,
//      and only for the kinds that rest on a confidence interval.
//
// There is no code path from here to anyone's performance record, and adding
// one would be a change to what this product does, not a feature.

import { parseJson, prisma } from '../db.js';
import { logger } from '../logger.js';
import type { CalibrationThresholds } from '../domain/calibration.js';
import {
  heldOutReviewers, organisationBaseline, patternAlerts, peerGaps, reviewerStatistics,
  type OrganisationBaseline, type PatternAlert, type PatternKind, type PeerLevel,
  type ReviewerStatistics, type ReviewRecord,
} from '../domain/reviewerPatterns.js';
import { logAudit } from './audit.js';
import { calibrationSettingsFor } from './calibrationSettings.js';
import { windowStart } from './calibrationAggregate.js';
import { UNBLINDED_READ_ACTION } from './shadowModeBlind.js';
import { BLIND_BYPASS_ACTION } from './shadowModeCommon.js';

export const PATTERN_VIEWED = 'reviewer.pattern.viewed';

/**
 * Every completed review in the window, as records the statistics can use.
 *
 * `secondsToRecord` comes from the audit trail the blind-review policy already
 * writes: the first unblinded read of an assessment by that reviewer, or the
 * moment they were let past the blind gate. Where neither was recorded, it is
 * null — reported as unknown, never estimated from `createdAt`, which is when
 * the row was written and not when the person started looking.
 */
export async function reviewRecordsFor(
  tenantId: string, thresholds: CalibrationThresholds, now = new Date(),
): Promise<{ reviews: ReviewRecord[]; peers: PeerLevel[] }> {
  const since = windowStart(thresholds, now);
  const differences = await prisma.reviewDifference.findMany({
    where: { tenantId, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    take: 20_000,
  });
  if (differences.length === 0) return { reviews: [], peers: [] };

  const reviewIds = differences.map((d) => d.reviewId);
  const [reviews, observations, opened] = await Promise.all([
    prisma.humanReview.findMany({
      where: { id: { in: reviewIds } },
      select: { id: true, reviewerId: true, assessmentId: true, comments: true, reason: true, completedAt: true, createdAt: true },
    }),
    prisma.calibrationObservation.findMany({
      where: { tenantId, reviewId: { in: reviewIds } },
      select: { reviewId: true, reviewerId: true, roleKey: true, competencyKey: true, band: true, humanLevel: true, blindReview: true },
    }),
    openedAtByReviewer(tenantId, since),
  ]);

  const reviewById = new Map(reviews.map((r) => [r.id, r]));
  const blindByReview = new Map(observations.map((o) => [o.reviewId, o.blindReview]));

  const records: ReviewRecord[] = [];
  for (const difference of differences) {
    const review = reviewById.get(difference.reviewId);
    if (!review || !review.completedAt) continue;
    const competencies = parseJson<Array<{ aiLevel: number | null; humanLevel: number | null; changed: boolean; reason: string }>>(
      difference.competenciesJson, [],
    );
    const changed = Array.isArray(competencies) ? competencies.filter((c) => c.changed) : [];
    const down = changed.filter((c) => (c.humanLevel ?? 0) < (c.aiLevel ?? 0)).length;
    const up = changed.filter((c) => (c.humanLevel ?? 0) > (c.aiLevel ?? 0)).length;
    const withReason = changed.filter((c) => (c.reason ?? '').trim().length > 0).length;

    const openedAt = opened.get(`${review.reviewerId}|${review.assessmentId}`);
    const seconds = openedAt ? Math.max(0, (review.completedAt.getTime() - openedAt.getTime()) / 1000) : null;

    records.push({
      reviewId: review.id,
      reviewerId: difference.reviewerId,
      assessmentId: difference.assessmentId,
      roleKey: '',
      aiVerdict: difference.aiRecommendation,
      humanVerdict: difference.humanDisposition,
      agreedWithAi: difference.agreed,
      overridesDown: down,
      overridesUp: up,
      competencyCount: difference.competencyCount,
      overridesWithReason: withReason,
      reasonChars: (difference.reason ?? '').length + (review.comments ?? '').length,
      secondsToRecord: seconds,
      recordedAt: review.completedAt,
      blindReview: blindByReview.get(review.id) === true,
    });
  }

  const peers: PeerLevel[] = observations
    .filter((o) => typeof o.humanLevel === 'number')
    .map((o) => ({
      reviewerId: o.reviewerId, roleKey: o.roleKey, competencyKey: o.competencyKey,
      band: o.band, level: o.humanLevel as number,
    }));
  return { reviews: records, peers };
}

/** When each reviewer first saw an assessment, from the blind-review audit trail. */
async function openedAtByReviewer(tenantId: string, since: Date): Promise<Map<string, Date>> {
  const events = await prisma.auditEvent.findMany({
    where: {
      tenantId,
      action: { in: [UNBLINDED_READ_ACTION, BLIND_BYPASS_ACTION] },
      createdAt: { gte: since },
    },
    select: { actorId: true, entityId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 50_000,
  });
  const map = new Map<string, Date>();
  for (const event of events) {
    const key = `${event.actorId}|${event.entityId}`;
    // The FIRST look, not the last: the question is how long they had the
    // assessment open before deciding, not when they last refreshed it.
    if (!map.has(key)) map.set(key, event.createdAt);
  }
  return map;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ReviewerPatternView {
  readonly reviewerId: string;
  readonly name: string;
  readonly statistics: ReviewerStatistics;
  readonly alerts: readonly PatternAlert[];
  readonly openAlertKinds: readonly string[];
  readonly heldOutOfCalibration: boolean;
}

export interface PatternReport {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly minimumReviews: number;
  readonly baseline: OrganisationBaseline;
  readonly reviewers: readonly ReviewerPatternView[];
  /** Said on the page, every time, in the product's own words. */
  readonly notice: string;
}

export const PATTERN_NOTICE = [
  'These are patterns, not findings. They describe what was recorded, over how many reviews, against what the rest of the organisation did.',
  'Nothing here concludes anything about a person, and nothing is done to anyone automatically. While a pattern is open, that reviewer\'s reviews stop feeding what the model learns — a brake on the model, not a mark against them — and that stops as soon as you close it.',
  'Questor keeps these statistics so that what it learns from human reviews can be checked. They are never part of anyone\'s performance record. Every reviewer can see their own figures, and every time an admin opens someone else\'s, that is recorded in the audit log.',
].join(' ');

/**
 * The whole organisation's patterns. Admin-only, and the caller audits the read
 * — this function does not, because it is also the source of a reviewer's own
 * figures, and a person looking at their own data is not an access event.
 */
export async function patternReport(tenantId: string, now = new Date()): Promise<PatternReport> {
  const settings = await calibrationSettingsFor(tenantId);
  const thresholds = settings.thresholds;
  const { reviews, peers } = await reviewRecordsFor(tenantId, thresholds, now);
  const gaps = peerGaps(peers);
  const baseline = organisationBaseline(reviews, gaps);

  const reviewerIds = [...new Set(reviews.map((r) => r.reviewerId))];
  const users = await prisma.user.findMany({
    where: { id: { in: reviewerIds }, tenantId }, select: { id: true, name: true, email: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name || u.email]));
  const openAlerts = await prisma.reviewerPatternAlert.findMany({
    where: { tenantId, status: 'open' }, select: { reviewerId: true, kind: true },
  });
  const heldOut = new Set(heldOutReviewers(openAlerts.map((a) => ({ reviewerId: a.reviewerId, kind: a.kind as PatternKind }))));

  const views: ReviewerPatternView[] = reviewerIds.map((reviewerId) => {
    const statistics = reviewerStatistics(reviewerId, reviews, gaps.get(reviewerId), thresholds);
    return {
      reviewerId,
      name: nameById.get(reviewerId) ?? 'A reviewer who no longer has an account',
      statistics,
      alerts: patternAlerts(statistics, baseline),
      openAlertKinds: openAlerts.filter((a) => a.reviewerId === reviewerId).map((a) => a.kind),
      heldOutOfCalibration: heldOut.has(reviewerId),
    };
  }).sort((a, b) => b.statistics.reviews - a.statistics.reviews);

  return {
    generatedAt: now.toISOString(),
    windowDays: thresholds.windowDays,
    minimumReviews: thresholds.reviewerPatternMinReviews,
    baseline,
    reviewers: views,
    notice: PATTERN_NOTICE,
  };
}

/** One reviewer's own figures — the same numbers, read by the person they are about. */
export async function ownPatternFor(tenantId: string, reviewerId: string, now = new Date()): Promise<ReviewerPatternView | null> {
  const report = await patternReport(tenantId, now);
  return report.reviewers.find((r) => r.reviewerId === reviewerId) ?? null;
}

/** Record that an admin opened someone else's figures. This is employee data. */
export async function auditPatternView(opts: {
  readonly tenantId: string;
  readonly actorId: string;
  readonly reviewerId: string | null;
  readonly requestId?: string;
}): Promise<void> {
  await logAudit({
    tenantId: opts.tenantId, actorId: opts.actorId, actorType: 'user', action: PATTERN_VIEWED,
    entityType: 'User', entityId: opts.reviewerId ?? '',
    after: { scope: opts.reviewerId ? 'one reviewer' : 'every reviewer in the organisation' },
    requestId: opts.requestId,
  });
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * Recompute the open alerts for an organisation.
 *
 * An alert that is still true is refreshed, not reopened. An alert that is no
 * longer true is closed on its own — a pattern that has gone away should stop
 * holding somebody out of calibration without anybody having to do anything.
 * An alert somebody has already decided is never reopened by this.
 */
export async function refreshPatternAlerts(tenantId: string, now = new Date()): Promise<{ opened: number; closed: number }> {
  const report = await patternReport(tenantId, now);
  let opened = 0;
  let closed = 0;

  const seen = new Set<string>();
  for (const reviewer of report.reviewers) {
    for (const alert of reviewer.alerts) {
      seen.add(`${alert.reviewerId}|${alert.kind}`);
      const existing = await prisma.reviewerPatternAlert.findUnique({
        where: { tenantId_reviewerId_kind: { tenantId, reviewerId: alert.reviewerId, kind: alert.kind } },
      });
      if (existing && existing.status !== 'open') continue;
      await prisma.reviewerPatternAlert.upsert({
        where: { tenantId_reviewerId_kind: { tenantId, reviewerId: alert.reviewerId, kind: alert.kind } },
        create: {
          tenantId, reviewerId: alert.reviewerId, kind: alert.kind, status: 'open',
          sample: alert.sample, observed: alert.observed, baseline: alert.baseline, statement: alert.statement,
        },
        update: { sample: alert.sample, observed: alert.observed, baseline: alert.baseline, statement: alert.statement, lastSeenAt: now },
      });
      if (!existing) {
        opened += 1;
        await logAudit({
          tenantId, actorType: 'system', action: 'reviewer.pattern.raised',
          entityType: 'ReviewerPatternAlert', entityId: alert.kind,
          after: { kind: alert.kind, sample: alert.sample, statement: alert.statement },
        });
      }
    }
  }

  const open = await prisma.reviewerPatternAlert.findMany({ where: { tenantId, status: 'open' } });
  for (const row of open) {
    if (seen.has(`${row.reviewerId}|${row.kind}`)) continue;
    await prisma.reviewerPatternAlert.update({
      where: { id: row.id },
      data: { status: 'dismissed', decidedById: 'system', decidedAt: now, decidedNote: 'The pattern is no longer present over the current window.' },
    });
    closed += 1;
  }
  return { opened, closed };
}

export class PatternAlertNotFound extends Error {}

export async function decidePatternAlert(opts: {
  readonly tenantId: string;
  readonly alertId: string;
  readonly decision: 'acknowledged' | 'dismissed';
  readonly actorId: string;
  readonly note: string;
}): Promise<void> {
  const row = await prisma.reviewerPatternAlert.findFirst({ where: { id: opts.alertId, tenantId: opts.tenantId } });
  if (!row) throw new PatternAlertNotFound('That alert is not one of this organisation\'s.');
  await prisma.reviewerPatternAlert.update({
    where: { id: row.id },
    data: { status: opts.decision, decidedById: opts.actorId, decidedAt: new Date(), decidedNote: opts.note },
  });
  await logAudit({
    tenantId: opts.tenantId, actorId: opts.actorId, actorType: 'user', action: `reviewer.pattern.${opts.decision}`,
    entityType: 'ReviewerPatternAlert', entityId: row.id,
    before: { status: row.status, kind: row.kind },
    // The note is what the person concluded, and it is theirs. Recorded as
    // given; the product never adds a conclusion of its own to it.
    after: { status: opts.decision, note: opts.note },
  });
}

/**
 * Reviewers held out of calibration right now.
 *
 * Never throws: if this cannot be read, calibration runs with everybody
 * included, which is the behaviour the product had before patterns existed.
 */
export async function heldOutForCalibration(tenantId: string): Promise<string[]> {
  try {
    const open = await prisma.reviewerPatternAlert.findMany({
      where: { tenantId, status: 'open' }, select: { reviewerId: true, kind: true },
    });
    return heldOutReviewers(open.map((a) => ({ reviewerId: a.reviewerId, kind: a.kind as PatternKind })));
  } catch (err) {
    logger.warn({ err: String(err), tenantId }, 'Open reviewer-pattern alerts could not be read; calibration includes every reviewer');
    return [];
  }
}
