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
/**
 * Organisations read per query. Every organisation is snapshotted on every
 * run; this only bounds how many are held in memory at once.
 *
 * It used to be a `take` with no cursor, which meant the 51st organisation was
 * never snapshotted at all — and would have looked, in the stored trend, like
 * an organisation that had never hired anyone.
 */
const TENANT_PAGE = 50;

/** A rate, stored as its counts. A percentage without its denominator is not something to keep. */
interface StoredRate {
  readonly n: number;
  readonly d: number;
}

function stored(rate: Rate): StoredRate {
  return { n: rate.numerator, d: rate.denominator };
}

export interface SnapshotCutRow {
  readonly label: string;
  readonly n: number;
  /**
   * Null for a group below SNAPSHOT_MIN_GROUP — including the folded "other"
   * row when even the fold is small. A count of interviews says nothing about
   * anyone; a proceed rate over three of them is one person's outcome.
   */
  readonly proceed: StoredRate | null;
}

export interface OutcomeSnapshotStats {
  readonly month: string;
  readonly interviews: number;
  /**
   * Null for a month with fewer than SNAPSHOT_MIN_GROUP interviews. The funnel
   * is not just activity: its later steps are verdicts and hires, and in a
   * one-interview month `hired: 1` is that person's outcome. `interviews`
   * survives on its own because a count of interviews is a fact about a month,
   * not about anybody in it.
   */
  readonly funnel: ReadonlyArray<{ readonly key: string; readonly count: number }> | null;
  /**
   * Null for a month with fewer than SNAPSHOT_MIN_GROUP interviews. In such a
   * month a score bucket, a median or a turn rate IS one person's interview,
   * and a snapshot that kept it would be personal data outliving the erasure
   * of everything it was derived from.
   */
  readonly scoreBuckets: ReadonlyArray<{ readonly from: number; readonly to: number; readonly count: number }> | null;
  readonly scoreMedian: number | null;
  readonly cuts: Readonly<Record<string, readonly SnapshotCutRow[]>>;
  readonly health: {
    readonly medianDurationMinutes: number | null;
    readonly nonAnswer: StoredRate;
    readonly rejoined: StoredRate;
    readonly heldFeedback: StoredRate;
    readonly degradedTurns: StoredRate;
  } | null;
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
 * A cut, reduced to what may be kept: the label, the size, and — only for a
 * group of at least SNAPSHOT_MIN_GROUP — the proceed rate as counts.
 *
 * Small groups are summed into one "other" row rather than dropped, so the
 * parts still add up to the month. That fold is not automatically safe: one
 * small group, or several that still total under the floor, leaves an "other"
 * row that is itself a handful of people. So the floor is applied to the
 * folded row too, and a group under it keeps its size and loses its rate.
 * A count of interviews says nothing about anyone; a proceed rate over three
 * of them is one person's outcome.
 */
function storableCut(
  groups: ReadonlyArray<{ label: string; n: number; humanVerdicts: Readonly<Record<'PROCEED', Rate>> }>,
): SnapshotCutRow[] {
  const keep = groups.filter((g) => g.n >= SNAPSHOT_MIN_GROUP);
  const small = groups.filter((g) => g.n < SNAPSHOT_MIN_GROUP);
  const rows: SnapshotCutRow[] = keep.map((g) => ({ label: g.label, n: g.n, proceed: stored(g.humanVerdicts.PROCEED) }));
  if (small.length === 0) return rows;
  const foldedN = small.reduce((total, g) => total + g.n, 0);
  return [...rows, {
    label: 'Other (groups too small to keep separately)',
    n: foldedN,
    proceed: foldedN < SNAPSHOT_MIN_GROUP ? null : {
      n: small.reduce((total, g) => total + g.humanVerdicts.PROCEED.numerator, 0),
      d: small.reduce((total, g) => total + g.humanVerdicts.PROCEED.denominator, 0),
    },
  }];
}

/**
 * The month's statistics for one organisation, as the aggregate that is safe
 * to keep.
 *
 * A month below SNAPSHOT_MIN_GROUP keeps how many interviews it had, and
 * nothing else. In a one-interview month the score median IS that person's
 * score, the median duration IS their interview, and the funnel's later steps
 * — reviewed, the verdict, hired — ARE their outcome. Keeping any of them
 * would put personal data in a table designed to outlive the erasure of
 * everything it came from. The bare count stays because "three interviews
 * happened in September" identifies nobody, and dropping the month entirely
 * would leave a hole in the trend that reads as "nothing happened".
 */
export async function buildSnapshot(auth: AuthClaims, month: string): Promise<OutcomeSnapshotStats> {
  const { rows } = await gatherOutcomeRows(auth, { period: monthRange(month) });
  const scores = scoreDistribution(rows.flatMap((r) => (r.overallScore === null ? [] : [r.overallScore])));
  const health = healthStats(rows);
  const bigEnough = rows.length >= SNAPSHOT_MIN_GROUP;
  return {
    month,
    interviews: rows.length,
    funnel: bigEnough ? buildFunnel(countFunnel(rows)).map((step: FunnelStep) => ({ key: step.key, count: step.count })) : null,
    scoreBuckets: bigEnough ? scores.buckets : null,
    scoreMedian: bigEnough ? scores.median : null,
    cuts: {
      interviewer: storableCut(cutBy(rows, 'interviewer')),
      experienceBand: storableCut(cutBy(rows, 'experienceBand')),
      region: storableCut(cutBy(rows, 'region')),
      scorecard: storableCut(cutBy(rows, 'scorecard')),
    },
    health: bigEnough ? {
      medianDurationMinutes: health.duration.median,
      nonAnswer: stored(health.nonAnswer),
      rejoined: stored(health.rejoined),
      heldFeedback: stored(health.heldFeedback),
      degradedTurns: stored(health.degradedTurns),
    } : null,
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

  let written = 0;
  let organisations = 0;
  let cursor: string | undefined;
  // Every organisation, a page at a time — a cursor, not a bare `take`, so the
  // list is finished rather than restarted from the top on each run.
  for (;;) {
    const tenants = await prisma.tenant.findMany({
      where: { isDemo: false },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: TENANT_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (tenants.length === 0) break;

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
      organisations += 1;
    }
    cursor = tenants[tenants.length - 1].id;
  }
  return `wrote ${written} snapshot(s) for ${organisations} organisation(s)`;
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
