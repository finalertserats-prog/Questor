import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { candidateScope, roleScope } from './access.js';
import type { AuthClaims } from './auth.js';
import { DEFAULT_STAGES } from '../domain/pipelineStages.js';
import { EXCEPTION_STATES } from '../domain/stateMachine.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Ceiling on the rows any one chart series reads, so a huge tenant cannot pull its whole history into memory. */
const SERIES_ROW_LIMIT = 20_000;
const SCHEDULE_HORIZON_DAYS = 7;
const COMPLETED_WINDOW_DAYS = 30;
// Wider than the 30-day completion KPI so a quiet month still yields an average.
const TURNAROUND_WINDOW_DAYS = 90;

/** States that mean the AI interview actually ran to its end. */
const COMPLETED_STATES = ['PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED'];
/** A scheduled time on a session in one of these states is not an upcoming interview. */
const NOT_UPCOMING_STATES = [...EXCEPTION_STATES, ...COMPLETED_STATES];
const DECISIONS = ['APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
type Decision = (typeof DECISIONS)[number];

export interface DashboardMetricsOptions {
  readonly weeks: number;
  readonly recent: number;
  readonly now?: Date;
}

export interface DashboardMetrics {
  readonly generatedAt: string;
  readonly kpis: {
    readonly openRoles: number;
    readonly candidates: number;
    readonly activePipelines: number;
    readonly scheduledNext7Days: number;
    readonly completedLast30Days: number;
    readonly awaitingReview: number;
    readonly avgInviteToCompleteHours: number | null;
    readonly decisions: Readonly<Record<Decision, number>>;
  };
  readonly interviewsPerWeek: ReadonlyArray<{ weekStart: string; created: number; completed: number }>;
  readonly pipelineStages: ReadonlyArray<{ key: string; label: string; count: number }>;
  readonly stateCounts: Readonly<Record<string, number>>;
  readonly recentInterviews: ReadonlyArray<{
    id: string; state: string; createdAt: Date; scheduledAt: Date | null; completedAt: Date | null;
    candidate: { id: string; name: string }; role: { id: string; title: string };
  }>;
}

/** Index of the rolling 7-day bucket a time falls in, newest = weeks - 1; -1 when outside. */
function bucketIndex(time: Date | null, now: number, weeks: number): number {
  if (!time) return -1;
  const age = now - time.getTime();
  if (age < 0) return -1;
  const fromNewest = Math.floor(age / WEEK_MS);
  return fromNewest < weeks ? weeks - 1 - fromNewest : -1;
}

function titleCase(key: string): string {
  return key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * KPIs and chart series for the HR dashboard.
 *
 * Every figure is object-scoped through `candidateScope` / `roleScope` — the
 * same definitions the candidate, interview and role lists use — so a
 * recruiter's dashboard can never count a candidate their lists would hide.
 * Sessions, pipelines and rounds carry no scope of their own and inherit it
 * through their candidate. Uses count/groupBy plus date-only selects bounded by
 * the chart window; no transcripts or JSON blobs are read.
 */
export async function getDashboardMetrics(auth: AuthClaims, options: DashboardMetricsOptions): Promise<DashboardMetrics> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const { tenantId } = auth;
  const [candScope, rScope] = await Promise.all([candidateScope(auth), roleScope(auth)]);
  const candidate = candScope as Prisma.CandidateWhereInput;

  const sessionWhere: Prisma.InterviewSessionWhereInput = { tenantId, candidate };
  const pipelineWhere: Prisma.CandidatePipelineWhereInput = { tenantId, candidate };
  // Human rounds only. An AI round carries the interview session it is run in,
  // and that session is already counted as an interview — counting the round
  // too showed one scheduled AI interview as two.
  const roundWhere: Prisma.InterviewRoundWhereInput = { tenantId, pipeline: { candidate }, conductedBy: 'HUMAN' };

  const windowStart = new Date(nowMs - options.weeks * WEEK_MS);
  const horizon = new Date(nowMs + SCHEDULE_HORIZON_DAYS * DAY_MS);
  const completedSince = new Date(nowMs - COMPLETED_WINDOW_DAYS * DAY_MS);
  const turnaroundSince = new Date(nowMs - TURNAROUND_WINDOW_DAYS * DAY_MS);

  const [
    openRoles, candidates, activePipelines,
    scheduledSessions, scheduledRounds,
    completedSessions, completedRounds,
    stateRows, stageRows, decisionRows,
    turnaroundRows, sessionSeries, roundSeries, recentRows,
  ] = await Promise.all([
    prisma.role.count({ where: { AND: [rScope as Prisma.RoleWhereInput, { status: { not: 'archived' } }] } }),
    prisma.candidate.count({ where: candidate }),
    prisma.candidatePipeline.count({ where: { ...pipelineWhere, status: 'ACTIVE' } }),
    prisma.interviewSession.count({
      where: { ...sessionWhere, scheduledAt: { gte: now, lt: horizon }, state: { notIn: NOT_UPCOMING_STATES } },
    }),
    prisma.interviewRound.count({ where: { ...roundWhere, status: 'SCHEDULED', scheduledAt: { gte: now, lt: horizon } } }),
    prisma.interviewSession.count({
      where: { ...sessionWhere, completedAt: { gte: completedSince }, state: { in: COMPLETED_STATES } },
    }),
    prisma.interviewRound.count({ where: { ...roundWhere, status: 'COMPLETED', completedAt: { gte: completedSince } } }),
    prisma.interviewSession.groupBy({ by: ['state'], where: sessionWhere, _count: { _all: true } }),
    prisma.candidatePipeline.groupBy({ by: ['currentStageKey'], where: { ...pipelineWhere, status: 'ACTIVE' }, _count: { _all: true } }),
    prisma.candidatePipeline.groupBy({ by: ['decision'], where: { ...pipelineWhere, status: 'DECIDED' }, _count: { _all: true } }),
    // These three read rows rather than counts, so they carry a ceiling: a
    // dashboard must not pull an unbounded tenant history into memory. The
    // averages and bars are indicative, and SERIES_ROW_LIMIT is far above what
    // any real tenant produces in the window.
    prisma.interviewSession.findMany({
      where: { ...sessionWhere, completedAt: { gte: turnaroundSince }, state: { in: COMPLETED_STATES }, invitation: { isNot: null } },
      select: { completedAt: true, invitation: { select: { sentAt: true, createdAt: true } } },
      take: SERIES_ROW_LIMIT,
    }),
    prisma.interviewSession.findMany({
      where: { ...sessionWhere, OR: [{ createdAt: { gte: windowStart } }, { completedAt: { gte: windowStart } }] },
      select: { createdAt: true, completedAt: true, state: true },
      take: SERIES_ROW_LIMIT,
    }),
    prisma.interviewRound.findMany({
      where: { ...roundWhere, OR: [{ createdAt: { gte: windowStart } }, { completedAt: { gte: windowStart } }] },
      select: { createdAt: true, completedAt: true, status: true },
      take: SERIES_ROW_LIMIT,
    }),
    prisma.interviewSession.findMany({
      where: sessionWhere,
      // id breaks ties so rows created in the same millisecond order the same
      // way on SQLite and Postgres.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.recent,
      select: {
        id: true, state: true, createdAt: true, scheduledAt: true, completedAt: true,
        candidate: { select: { id: true, fullName: true } },
        role: { select: { id: true, title: true } },
      },
    }),
  ]);

  const decisions: Record<Decision, number> = { APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 };
  for (const row of decisionRows) {
    if (row.decision && (DECISIONS as readonly string[]).includes(row.decision)) {
      decisions[row.decision as Decision] = row._count._all;
    }
  }

  const turnaroundHours = turnaroundRows
    .map((r) => {
      const invitedAt = r.invitation?.sentAt ?? r.invitation?.createdAt;
      return invitedAt && r.completedAt ? (r.completedAt.getTime() - invitedAt.getTime()) / HOUR_MS : null;
    })
    .filter((h): h is number => h !== null && h >= 0);
  const avgInviteToCompleteHours = turnaroundHours.length
    ? Math.round((turnaroundHours.reduce((a, b) => a + b, 0) / turnaroundHours.length) * 10) / 10
    : null;

  const buckets = Array.from({ length: options.weeks }, (_, i) => ({
    weekStart: new Date(nowMs - (options.weeks - i) * WEEK_MS).toISOString(),
    created: 0,
    completed: 0,
  }));
  const tally = (createdAt: Date, completedAt: Date | null, completed: boolean) => {
    const c = bucketIndex(createdAt, nowMs, options.weeks);
    if (c >= 0) buckets[c] = { ...buckets[c], created: buckets[c].created + 1 };
    const d = completed ? bucketIndex(completedAt, nowMs, options.weeks) : -1;
    if (d >= 0) buckets[d] = { ...buckets[d], completed: buckets[d].completed + 1 };
  };
  for (const s of sessionSeries) tally(s.createdAt, s.completedAt, COMPLETED_STATES.includes(s.state));
  for (const r of roundSeries) tally(r.createdAt, r.completedAt, r.status === 'COMPLETED');

  // Default medallion stages always appear, in order, so the chart shape is
  // stable; stage keys from a role's custom plan are appended after them.
  const stageCounts = new Map(stageRows.map((row) => [row.currentStageKey, row._count._all]));
  const defaultKeys = new Set(DEFAULT_STAGES.map((s) => s.key));
  const pipelineStages = [
    ...DEFAULT_STAGES.map((s) => ({ key: s.key, label: s.label, count: stageCounts.get(s.key) ?? 0 })),
    ...[...stageCounts.entries()]
      .filter(([key]) => !defaultKeys.has(key))
      .map(([key, count]) => ({ key, label: titleCase(key), count })),
  ];

  return {
    generatedAt: now.toISOString(),
    kpis: {
      openRoles,
      candidates,
      activePipelines,
      scheduledNext7Days: scheduledSessions + scheduledRounds,
      completedLast30Days: completedSessions + completedRounds,
      awaitingReview: stateRows.find((r) => r.state === 'REVIEW_READY')?._count._all ?? 0,
      avgInviteToCompleteHours,
      decisions,
    },
    interviewsPerWeek: buckets,
    pipelineStages,
    stateCounts: Object.fromEntries(stateRows.map((r) => [r.state, r._count._all])),
    recentInterviews: recentRows.map((s) => ({
      id: s.id, state: s.state, createdAt: s.createdAt, scheduledAt: s.scheduledAt, completedAt: s.completedAt,
      candidate: { id: s.candidate.id, name: s.candidate.fullName },
      role: { id: s.role.id, title: s.role.title },
    })),
  };
}
