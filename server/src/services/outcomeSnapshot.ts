import { prisma } from '../db.js';
import { config } from '../config.js';
import { buildFunnel, countFunnel, cutBy, healthStats, scoreDistribution, type FunnelStep, type Rate } from '../domain/outcomeStats.js';
import { gatherOutcomeRows } from './outcomeStats.js';
import type { AuthClaims } from './auth.js';
import { startJob } from './jobs.js';

/**
 * Monthly outcome snapshots (OUTCOME_SNAPSHOT_ENABLED, off by default).
 *
 * WHY. Candidate data is erased — on request under Art. 17, and on the
 * retention sweep. That is right, and it also means a month's funnel stops
 * being computable once the people in it are gone. Monitoring that can only
 * describe the data still present cannot show a trend, and the trend is the
 * point.
 *
 * WHAT IS STORED. Counts and rates over a whole organisation-month, and
 * nothing else. No candidate id, no session id, no name, no one person's
 * score, no cut small enough to be one person — a group below the minimum
 * sample is written as "other", so no month can be intersected with another to
 * isolate an individual.
 *
 * ERASURE. A snapshot is not personal data and holds no key back to a person,
 * so erasing a candidate neither reads nor writes this table. That is a
 * property of what is stored, not a policy someone has to remember: there is
 * nothing here to erase. `eraseCandidate` is deliberately not taught about
 * snapshots, and tests assert that an erasure still succeeds with snapshots
 * present.
 */

export const OUTCOME_SNAPSHOT_JOB = { name: 'outcome-snapshot', intervalMs: 6 * 3_600_000, ttlMs: 30 * 60_000 } as const;

/** Cuts smaller than this are folded into "other" so no stored group can be one person. */
export const SNAPSHOT_MIN_GROUP = 5;
/** Organisations handled per run; a large deployment finishes over a few runs. */
const TENANTS_PER_RUN = 50;

/** A rate, stored as its counts. A percentage without its denominator is not something to keep. */
interface StoredRate {
  readonly n: number;
  readonly d: number;
}

function stored(rate: Rate): StoredRate {
  return { n: rate.numerator, d: rate.denominator };
}

export interface OutcomeSnapshotStats {
  readonly month: string;
  readonly interviews: number;
  readonly funnel: ReadonlyArray<{ readonly key: string; readonly count: number }>;
  readonly scoreBuckets: ReadonlyArray<{ readonly from: number; readonly to: number; readonly count: number }>;
  readonly scoreMedian: number | null;
  readonly cuts: Readonly<Record<string, ReadonlyArray<{ readonly label: string; readonly n: number; readonly proceed: StoredRate }>>>;
  readonly health: {
    readonly medianDurationMinutes: number | null;
    readonly nonAnswer: StoredRate;
    readonly rejoined: StoredRate;
    readonly heldFeedback: StoredRate;
    readonly degradedTurns: StoredRate;
  };
}

/** The UTC month of a date, as 'YYYY-MM'. */
export function snapshotMonth(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The half-open UTC range of a 'YYYY-MM'. */
export function monthRange(month: string): { from: Date; to: Date } {
  const from = new Date(`${month}-01T00:00:00.000Z`);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  return { from, to };
}

/**
 * A cut, reduced to what may be kept: the label, the size, and the proceed
 * rate as counts. Groups below SNAPSHOT_MIN_GROUP are summed into one "other"
 * row rather than dropped, so the parts still add up to the month.
 */
function storableCut(
  groups: ReadonlyArray<{ label: string; n: number; humanVerdicts: Readonly<Record<'PROCEED', Rate>> }>,
): Array<{ label: string; n: number; proceed: StoredRate }> {
  const keep = groups.filter((g) => g.n >= SNAPSHOT_MIN_GROUP);
  const small = groups.filter((g) => g.n < SNAPSHOT_MIN_GROUP);
  const rows = keep.map((g) => ({ label: g.label, n: g.n, proceed: stored(g.humanVerdicts.PROCEED) }));
  if (small.length === 0) return rows;
  return [...rows, {
    label: 'Other (groups too small to keep separately)',
    n: small.reduce((total, g) => total + g.n, 0),
    proceed: {
      n: small.reduce((total, g) => total + g.humanVerdicts.PROCEED.numerator, 0),
      d: small.reduce((total, g) => total + g.humanVerdicts.PROCEED.denominator, 0),
    },
  }];
}

/** The month's statistics for one organisation, as the aggregate that is safe to keep. */
export async function buildSnapshot(auth: AuthClaims, month: string): Promise<OutcomeSnapshotStats> {
  const { rows } = await gatherOutcomeRows(auth, { period: monthRange(month) });
  const scores = scoreDistribution(rows.flatMap((r) => (r.overallScore === null ? [] : [r.overallScore])));
  const health = healthStats(rows);
  return {
    month,
    interviews: rows.length,
    funnel: buildFunnel(countFunnel(rows)).map((step: FunnelStep) => ({ key: step.key, count: step.count })),
    scoreBuckets: scores.buckets,
    scoreMedian: scores.median,
    cuts: {
      interviewer: storableCut(cutBy(rows, 'interviewer')),
      experienceBand: storableCut(cutBy(rows, 'experienceBand')),
      region: storableCut(cutBy(rows, 'region')),
      scorecard: storableCut(cutBy(rows, 'scorecard')),
    },
    health: {
      medianDurationMinutes: health.duration.median,
      nonAnswer: stored(health.nonAnswer),
      rejoined: stored(health.rejoined),
      heldFeedback: stored(health.heldFeedback),
      degradedTurns: stored(health.degradedTurns),
    },
  };
}

/**
 * Snapshot claims read the whole organisation, not one user's scope, so they
 * run as the organisation itself rather than as whoever happened to be logged
 * in. An admin's claims with no user id: no assignment filter applies, and no
 * real account is impersonated in the audit trail, because nothing is audited —
 * this writes only aggregates.
 */
function tenantClaims(tenantId: string): AuthClaims {
  return { userId: '', tenantId, role: 'admin', email: '' };
}

/**
 * Write (or rewrite) the snapshot for each organisation's current and previous
 * month. The current month is rewritten on every run because it is still
 * filling; the previous one is rewritten until it has settled, which costs one
 * extra pass and removes the need for a "did the last run of the month
 * happen?" question nobody would think to ask.
 */
export async function runOutcomeSnapshots(now: Date = new Date()): Promise<string> {
  const current = snapshotMonth(now);
  const previous = snapshotMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const tenants = await prisma.tenant.findMany({
    where: { isDemo: false },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: TENANTS_PER_RUN,
  });

  let written = 0;
  for (const tenant of tenants) {
    for (const month of [previous, current]) {
      const stats = await buildSnapshot(tenantClaims(tenant.id), month);
      await prisma.outcomeSnapshot.upsert({
        where: { tenantId_month: { tenantId: tenant.id, month } },
        create: { tenantId: tenant.id, month, interviews: stats.interviews, statsJson: JSON.stringify(stats) },
        update: { interviews: stats.interviews, statsJson: JSON.stringify(stats) },
      });
      written += 1;
    }
  }
  return `wrote ${written} snapshot(s) for ${tenants.length} organisation(s)`;
}

/** Start the sweep, unless the switch is off. Returns a stop function either way. */
export function startOutcomeSnapshots(intervalMs: number = OUTCOME_SNAPSHOT_JOB.intervalMs): () => void {
  if (!config.outcomeSnapshotEnabled) return () => undefined;
  return startJob({ ...OUTCOME_SNAPSHOT_JOB, intervalMs, delayFirst: true, fn: () => runOutcomeSnapshots() });
}

/** The stored months for one organisation, newest first. Aggregates only. */
export async function listOutcomeSnapshots(tenantId: string, limit = 24): Promise<OutcomeSnapshotStats[]> {
  const rows = await prisma.outcomeSnapshot.findMany({
    where: { tenantId },
    orderBy: { month: 'desc' },
    take: limit,
    select: { month: true, statsJson: true },
  });
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.statsJson) as OutcomeSnapshotStats];
    } catch {
      // A snapshot that cannot be read is left out rather than shown as an
      // empty month, which would read as "nothing happened".
      return [];
    }
  });
}
