import type { Prisma } from '@prisma/client';
import { parseJsonOptional, prisma } from '../db.js';
import { detectCandidateIntent } from '../engines/candidateIntent.js';
import type { AssessmentResult } from '../domain/types.js';
import { isVerdict, type Verdict } from '../domain/verdict.js';
import {
  CUT_DIMENSIONS, OUTCOME_MIN_SAMPLE, buildFunnel, countFunnel, cutBy, healthStats, levelDistribution,
  scoreDistribution, unblindedAgreement,
  type CutDimension, type CutGroup, type FunnelStep, type HealthStats, type LevelDistribution,
  type OutcomeRow, type ReviewDifferenceRow, type ScoreDistribution, type UnblindedAgreement,
} from '../domain/outcomeStats.js';
import { candidateScope, roleScope } from './access.js';
import type { AuthClaims } from './auth.js';
import { getAgreementReport, type AgreementReport } from './shadowMode.js';
import { COMPLETED_STATES } from './dashboardMetrics.js';

/**
 * Outcome statistics, gathered.
 *
 * CONTRACT — how each number is derived.
 *  - The population is AI interview sessions (`InterviewSession`) CREATED in
 *    the period, inside the caller's role and candidate scope. One row per
 *    interview, so a retake is its own row; folding retakes into the first
 *    attempt would hide the thing a health statistic is for.
 *  - `invited`   — the session has an `Invitation` row.
 *  - `started`   — `startedAt` is set.
 *  - `completed` — the session reached a completed state (COMPLETED_STATES, the
 *    same list the dashboard counts). An interview that stopped part-way has
 *    `interruptedAt` and is NOT completed.
 *  - `assessed`  — at least one `AssessmentVersion` exists; the latest version
 *    is the one read.
 *  - `humanReviewed` — a `HumanReview` is the active completed review of that
 *    assessment (`activeForAssessmentId`). A blind verdict is not a review and
 *    does not count here.
 *  - the verdict — the reviewer's `disposition`, in the one vocabulary
 *    (domain/verdict.ts). The AI's own call is `AssessmentVersion.recommendation`.
 *  - `hired`     — the candidate's `CandidatePipeline` for that role is DECIDED
 *    with decision APPROVED. Questor never hears about an offer or its
 *    acceptance, so this is the last thing the product knows, not a confirmed
 *    hire, and the page says so.
 *  - `overallScore` and competency levels come from the assessment's stored
 *    `resultJson`; a competency with no evidence contributes no level rather
 *    than a zero.
 *  - non-answer turns are classified from the transcript by the same pure
 *    reader the interview itself uses (`detectCandidateIntent`). The text is
 *    read in batches, counted and discarded — only counts leave this function.
 *  - degraded turns are agent turns whose `metaJson.serving.degraded` is set:
 *    the primary model was unavailable and something thinner wrote the turn.
 *  - rejoins come from the `interview.rejoined` audit action.
 *
 * ROW CEILING. `OUTCOME_ROW_LIMIT` is lower than the dashboard's because every
 * row here also parses an assessment's stored JSON. Hitting it sets
 * `truncated`, and the newest interviews are the ones kept.
 *
 * WHAT THIS IS NOT. There is no group attribute anywhere in it. This cannot be
 * an adverse-impact analysis and must never be presented as one.
 */

const DAY_MS = 24 * 3_600_000;
export const OUTCOME_ROW_LIMIT = 5_000;
/** Sessions whose transcripts are read in one query, so peak memory is one batch, not the period. */
const TRANSCRIPT_BATCH = 200;
/** How far back the report looks when the caller names no period. */
export const DEFAULT_PERIOD_DAYS = 365;
/** The proficiency scale competency levels are counted on (domain/types.ts Proficiency). */
export const PROFICIENCY_LEVELS = [0, 1, 2, 3, 4, 5] as const;
/** Audit action written when a candidate comes back into a room they had lost. */
const REJOINED_ACTION = 'interview.rejoined';

export interface OutcomePeriod {
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
}

export interface OutcomeStatsOptions {
  readonly period?: Partial<OutcomePeriod>;
  readonly roleId?: string;
  readonly now?: Date;
  /** Test seam for the row ceiling; production uses OUTCOME_ROW_LIMIT. */
  readonly rowLimit?: number;
}

export interface CompetencyDistribution extends LevelDistribution {
  readonly competencyId: string;
  readonly competencyName: string;
}

export interface OutcomeReport {
  readonly generatedAt: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly roleId: string | null;
  /** True when the row ceiling was hit: the newest interviews only. */
  readonly truncated: boolean;
  /** The denominator below which no rate on this page may be read. */
  readonly minSample: number;
  readonly interviews: number;
  readonly funnel: readonly FunnelStep[];
  readonly scores: ScoreDistribution;
  readonly competencies: readonly CompetencyDistribution[];
  readonly cuts: Readonly<Record<CutDimension, readonly CutGroup[]>>;
  readonly health: HealthStats;
  /** Reviews made with the AI's answer already on screen. Not a validity statistic. */
  readonly reviewerChanges: UnblindedAgreement;
  /** The blind-verdict agreement harness, verbatim: the only agreement figure about scoring validity. */
  readonly agreement: AgreementReport;
  /**
   * Said out loud because it is the one number on this page that does not
   * follow the page's own filters. Reusing the harness unchanged is the point
   * — re-scoping it here would invent a second definition of how shadow
   * metrics are measured, and the assessment page would then disagree with
   * this one about whether the scoring is validated.
   */
  readonly agreementScopeNote: string;
}

const AGREEMENT_SCOPE_NOTE =
  'The blind-verdict agreement figures describe the whole organisation and every period, '
  + 'whatever period or role is selected above. They come unchanged from the same harness the '
  + 'assessment page shows (services/shadowMode.ts), so the two can never disagree about whether '
  + 'the scoring has been validated.';

/** The period the report covers: whatever the caller asked for, else the last year up to now. */
export function resolvePeriod(options: OutcomeStatsOptions): OutcomePeriod {
  const now = options.now ?? new Date();
  const to = options.period?.to ?? now;
  const from = options.period?.from ?? new Date(to.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS);
  return { from, to };
}

const sessionSelect = {
  id: true,
  createdAt: true,
  state: true,
  startedAt: true,
  completedAt: true,
  personaJson: true,
  candidateId: true,
  roleId: true,
  role: { select: { title: true, experienceBand: true, regionCode: true } },
  scorecard: { select: { id: true, version: true, role: { select: { title: true } } } },
  invitation: { select: { id: true } },
  feedbackEmail: { select: { status: true, heldAt: true } },
  assessments: {
    orderBy: { version: 'desc' as const },
    take: 1,
    select: { id: true, recommendation: true, evidenceCoverage: true, resultJson: true },
  },
} satisfies Prisma.InterviewSessionSelect;

type SessionRow = Prisma.InterviewSessionGetPayload<{ select: typeof sessionSelect }>;

/** 'YYYY-MM' in UTC. One clock for the whole report, named rather than the server's. */
function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The AI interviewer this session was run by, from the stored persona; '' when it predates the catalogue. */
function interviewerIdOf(session: SessionRow): string {
  const persona = parseJsonOptional<{ interviewerId?: unknown }>(
    session.personaJson, {}, { model: 'InterviewSession', id: session.id, field: 'personaJson' },
  );
  return typeof persona.interviewerId === 'string' ? persona.interviewerId : '';
}

/** The assessment's stored result, or null when it cannot be read — never a made-up empty one. */
function readResult(assessment: { id: string; resultJson: string } | undefined): AssessmentResult | null {
  if (!assessment) return null;
  const parsed = parseJsonOptional<Partial<AssessmentResult>>(
    assessment.resultJson, {}, { model: 'AssessmentVersion', id: assessment.id, field: 'resultJson' },
  );
  return Array.isArray(parsed.competencies) ? (parsed as AssessmentResult) : null;
}

interface TranscriptCounts {
  readonly candidateTurns: number;
  readonly nonAnswerTurns: number;
  readonly agentTurns: number;
  readonly degradedTurns: number;
}

const NO_TURNS: TranscriptCounts = { candidateTurns: 0, nonAnswerTurns: 0, agentTurns: 0, degradedTurns: 0 };

/**
 * Turn counts per session, read in batches.
 *
 * The candidate's words are read here and counted here. Nothing but the four
 * numbers above leaves this function, and no text is retained between batches —
 * which is what makes a whole-tenant statistic possible without assembling a
 * copy of everyone's transcript in memory.
 */
async function transcriptCounts(sessionIds: readonly string[]): Promise<Map<string, TranscriptCounts>> {
  const counts = new Map<string, TranscriptCounts>();
  for (let i = 0; i < sessionIds.length; i += TRANSCRIPT_BATCH) {
    const batch = sessionIds.slice(i, i + TRANSCRIPT_BATCH);
    const turns = await prisma.turn.findMany({
      where: { sessionId: { in: batch } },
      select: { sessionId: true, speaker: true, text: true, metaJson: true },
    });
    for (const turn of turns) {
      const current = counts.get(turn.sessionId) ?? NO_TURNS;
      if (turn.speaker === 'candidate') {
        const intent = detectCandidateIntent(turn.text).intent;
        counts.set(turn.sessionId, {
          ...current,
          candidateTurns: current.candidateTurns + 1,
          nonAnswerTurns: current.nonAnswerTurns + (intent === 'non_answer' ? 1 : 0),
        });
      } else if (turn.speaker === 'agent') {
        const meta = parseJsonOptional<{ serving?: { degraded?: unknown } }>(
          turn.metaJson, {}, { model: 'Turn', id: turn.sessionId, field: 'metaJson' },
        );
        counts.set(turn.sessionId, {
          ...current,
          agentTurns: current.agentTurns + 1,
          degradedTurns: current.degradedTurns + (meta.serving?.degraded === true ? 1 : 0),
        });
      }
    }
  }
  return counts;
}

interface Gathered {
  readonly rows: readonly OutcomeRow[];
  readonly differences: readonly ReviewDifferenceRow[];
  readonly truncated: boolean;
}

/** Every interview in the period, flattened into the rows the pure statistics fold over. */
export async function gatherOutcomeRows(auth: AuthClaims, options: OutcomeStatsOptions = {}): Promise<Gathered> {
  const { from, to } = resolvePeriod(options);
  const rowLimit = options.rowLimit ?? OUTCOME_ROW_LIMIT;
  const { tenantId } = auth;
  const [rScope, cScope] = await Promise.all([roleScope(auth), candidateScope(auth)]);
  const role = (options.roleId
    ? { AND: [rScope as Prisma.RoleWhereInput, { id: options.roleId }] }
    : rScope) as Prisma.RoleWhereInput;
  const candidate = cScope as Prisma.CandidateWhereInput;

  // Filter through the relations rather than an `in` list of ids: an id list
  // can run to thousands, past what SQLite binds in one statement.
  const sessionWhere: Prisma.InterviewSessionWhereInput = {
    tenantId, role, candidate, createdAt: { gte: from, lt: to },
  };

  const sessions = await prisma.interviewSession.findMany({
    where: sessionWhere,
    select: sessionSelect,
    // Newest first, so the ceiling drops old interviews rather than an
    // arbitrary database subset — the same policy the dashboard's series use.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: rowLimit,
  });

  // Every one of these carries the same ceiling as the session read. Without
  // it the "5,000 rows" the report claims to be built from would bound only
  // one of six queries, and a long period in a large tenant would quietly
  // load far more than that.
  const [reviews, hiredPipelines, interviewers, rejoinRows, differenceRows] = await Promise.all([
    prisma.humanReview.findMany({
      // The one completed review of each assessment. A BLIND verdict carries no
      // activeForAssessmentId and is therefore never counted as a review here.
      where: { activeForAssessmentId: { not: null }, assessment: { session: sessionWhere } },
      select: { assessmentId: true, disposition: true },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: rowLimit,
    }),
    prisma.candidatePipeline.findMany({
      // Decided at or after the period started, with no upper bound: someone
      // interviewed inside the period and taken a fortnight later was still
      // hired off that interview, and cutting at `to` would lose them.
      where: { tenantId, role, candidate, status: 'DECIDED', decision: 'APPROVED', decidedAt: { gte: from } },
      select: { candidateId: true, roleId: true },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: rowLimit,
    }),
    prisma.aIInterviewer.findMany({ select: { id: true, name: true } }),
    // By period rather than by session id, for the same bind-limit reason; a
    // rejoin of an interview created just before the period is simply not seen.
    prisma.auditEvent.groupBy({
      by: ['entityId'],
      where: { tenantId, action: REJOINED_ACTION, createdAt: { gte: from, lt: to } },
      _count: { _all: true },
      orderBy: { entityId: 'asc' },
      take: rowLimit,
    }),
    prisma.reviewDifference.findMany({
      where: { tenantId, assessment: { session: sessionWhere } },
      select: { aiRecommendation: true, humanDisposition: true, agreed: true, competenciesJson: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: rowLimit,
    }),
  ]);

  const turns = await transcriptCounts(sessions.map((s) => s.id));

  const verdictByAssessment = new Map<string, Verdict>();
  for (const review of reviews) {
    if (isVerdict(review.disposition)) verdictByAssessment.set(review.assessmentId, review.disposition);
  }
  const hired = new Set(hiredPipelines.map((p) => `${p.candidateId}:${p.roleId}`));
  const interviewerNames = new Map(interviewers.map((i) => [i.id, i.name] as const));
  const rejoins = new Map(rejoinRows.map((r) => [r.entityId, r._count._all] as const));

  const rows = sessions.map((session): OutcomeRow => {
    const assessment = session.assessments[0];
    const result = readResult(assessment);
    const interviewerId = interviewerIdOf(session);
    const counts = turns.get(session.id) ?? NO_TURNS;
    const duration = session.startedAt && session.completedAt
      ? Math.round(((session.completedAt.getTime() - session.startedAt.getTime()) / 60_000) * 10) / 10
      : null;
    return {
      sessionId: session.id,
      roleId: session.roleId,
      roleTitle: session.role.title,
      interviewerId,
      interviewerName: interviewerNames.get(interviewerId) ?? interviewerId,
      experienceBand: session.role.experienceBand ?? '',
      regionCode: session.role.regionCode ?? '',
      scorecardId: session.scorecard.id,
      scorecardLabel: `${session.scorecard.role.title} v${session.scorecard.version}`,
      month: monthOf(session.createdAt),
      invited: session.invitation !== null,
      started: session.startedAt !== null,
      completed: COMPLETED_STATES.includes(session.state),
      assessed: assessment !== undefined,
      aiVerdict: assessment && isVerdict(assessment.recommendation) ? assessment.recommendation : null,
      humanReviewed: assessment !== undefined && verdictByAssessment.has(assessment.id),
      humanVerdict: assessment ? verdictByAssessment.get(assessment.id) ?? null : null,
      hired: hired.has(`${session.candidateId}:${session.roleId}`),
      overallScore: typeof result?.overallScore === 'number' ? result.overallScore : null,
      competencyLevels: (result?.competencies ?? []).flatMap((c) =>
        typeof c.level === 'number' && !c.notEnoughEvidence ? [{ id: c.id, name: c.name, level: c.level }] : []),
      durationMinutes: duration,
      candidateTurns: counts.candidateTurns,
      nonAnswerTurns: counts.nonAnswerTurns,
      evidenceCoverage: assessment ? assessment.evidenceCoverage : null,
      rejoins: rejoins.get(session.id) ?? 0,
      feedbackHeld: session.feedbackEmail?.status === 'HELD' || session.feedbackEmail?.heldAt != null,
      agentTurns: counts.agentTurns,
      degradedTurns: counts.degradedTurns,
    };
  });

  const differences = differenceRows.map((d): ReviewDifferenceRow => ({
    aiRecommendation: d.aiRecommendation,
    humanDisposition: d.humanDisposition,
    agreed: d.agreed,
    competencies: parseCompetencyDifferences(d.competenciesJson),
  }));

  // Any read that hit its ceiling makes the whole report a report of the
  // newest rows, not of the period, and the page must say so.
  const truncated = sessions.length >= rowLimit
    || reviews.length >= rowLimit
    || hiredPipelines.length >= rowLimit
    || rejoinRows.length >= rowLimit
    || differenceRows.length >= rowLimit;

  return { rows, differences, truncated };
}

/** The stored per-competency comparison, or nothing when the row cannot be read. */
function parseCompetencyDifferences(json: string): ReviewDifferenceRow['competencies'] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const e = entry as Record<string, unknown>;
      return [{
        competencyId: typeof e.competencyId === 'string' ? e.competencyId : '',
        competencyName: typeof e.competencyName === 'string' ? e.competencyName : '',
        aiLevel: typeof e.aiLevel === 'number' ? e.aiLevel : null,
        humanLevel: typeof e.humanLevel === 'number' ? e.humanLevel : null,
        changed: e.changed === true,
      }];
    });
  } catch {
    return [];
  }
}

/** Per-competency level distributions, the competencies with the most graded interviews first. */
function competencyDistributions(rows: readonly OutcomeRow[], minSample: number): CompetencyDistribution[] {
  const grouped = new Map<string, { name: string; levels: number[] }>();
  for (const row of rows) {
    for (const competency of row.competencyLevels) {
      const entry = grouped.get(competency.id) ?? { name: competency.name, levels: [] };
      entry.levels.push(competency.level);
      grouped.set(competency.id, entry);
    }
  }
  return [...grouped.entries()]
    .map(([competencyId, entry]) => ({
      competencyId,
      competencyName: entry.name,
      ...levelDistribution(entry.levels, [...PROFICIENCY_LEVELS], minSample),
    }))
    .sort((a, b) => b.n - a.n || a.competencyName.localeCompare(b.competencyName));
}

/** The whole report for one organisation and period. */
export async function getOutcomeReport(auth: AuthClaims, options: OutcomeStatsOptions = {}): Promise<OutcomeReport> {
  const period = resolvePeriod(options);
  const [{ rows, differences, truncated }, agreement] = await Promise.all([
    gatherOutcomeRows(auth, options),
    // The blind-verdict harness, reused rather than recomputed: it is
    // tenant-wide by design and this must not invent a second reading of it.
    getAgreementReport(auth.tenantId),
  ]);

  const cuts = Object.fromEntries(
    CUT_DIMENSIONS.map((dimension) => [dimension, cutBy(rows, dimension, OUTCOME_MIN_SAMPLE)]),
  ) as Record<CutDimension, readonly CutGroup[]>;

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    roleId: options.roleId ?? null,
    truncated,
    minSample: OUTCOME_MIN_SAMPLE,
    interviews: rows.length,
    funnel: buildFunnel(countFunnel(rows), OUTCOME_MIN_SAMPLE),
    scores: scoreDistribution(rows.flatMap((r) => (r.overallScore === null ? [] : [r.overallScore])), 10, OUTCOME_MIN_SAMPLE),
    competencies: competencyDistributions(rows, OUTCOME_MIN_SAMPLE),
    cuts,
    health: healthStats(rows, OUTCOME_MIN_SAMPLE),
    reviewerChanges: unblindedAgreement(differences, OUTCOME_MIN_SAMPLE),
    agreement,
    agreementScopeNote: AGREEMENT_SCOPE_NOTE,
  };
}
