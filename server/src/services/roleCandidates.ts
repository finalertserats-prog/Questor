import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, parseJsonOptional } from '../db.js';
import { candidateScope, hasCapability } from './access.js';
import type { AuthClaims } from './auth.js';
import { aiConclusionVisible } from './shadowMode.js';
import { humanVerdict } from '../domain/reviewedAssessment.js';
import { outcomeLabel } from '../domain/verdict.js';
import { DECISION_OUTCOMES, type DecisionOutcome } from '../domain/pipelineAutonomy.js';
import { parseStages } from '../domain/pipelineStages.js';
import { anyFieldMatches, foldText, pageMeta, pagingQuerySchema, skipFor, type PageMeta } from './listPaging.js';
import {
  DEFAULT_DIRECTION,
  DEFAULT_SORT,
  SORT_KEYS,
  comparabilityNotes,
  sortCandidates,
  type ComparabilityNote,
  type SortDirection,
  type SortKey,
  type SortableCandidate,
} from '../domain/candidateComparison.js';
import type { AssessmentResult } from '../domain/types.js';

/**
 * One role's applicants, ordered for comparison.
 *
 * The role page listed no candidates at all, so a manager comparing three
 * people worked from three separate pages. This is the shared loader behind
 * the candidates table, the skills grid and the side-by-side: all three must
 * answer with the same rows in the same order, or the grid's second column is
 * not the table's second row.
 *
 * Ordering happens HERE, not in the browser: the page shows 25 rows of a
 * pipeline that may hold hundreds, and a sort applied to the visible page is a
 * sort of the wrong set.
 *
 * It orders a narrow scan of the role's applicants in application code rather
 * than in SQL, which is the same trade the Candidates and Interviews lists
 * make (services/candidateList.ts) and for the same reasons: the verdict and
 * the stage live inside JSON columns, and case-insensitive search behaves
 * differently on SQLite and Postgres, so the two would disagree. The scan
 * selects no large field — the assessment's result JSON is read only for the
 * rows that end up on the page — and it is bounded by ONE role's pipeline
 * rather than the tenant's.
 */

/**
 * `dir` is defaulted FROM the key, not globally: every column but the name
 * opens at the strongest value, and the name opens at A. Defaulting the whole
 * query to `desc` made a hand-typed `?sort=name` answer Z-to-A while the page
 * that never omits `dir` answered A-to-Z — one order with two meanings.
 */
export const roleCandidatesQuerySchema = pagingQuerySchema.extend({
  sort: z.enum(SORT_KEYS).default(DEFAULT_SORT),
  dir: z.enum(['asc', 'desc']).optional(),
}).strict().transform((q) => ({ ...q, dir: q.dir ?? DEFAULT_DIRECTION[q.sort] }));

export type RoleCandidatesQuery = z.infer<typeof roleCandidatesQuerySchema>;

/**
 * Narrow enough to run over a whole pipeline. The assessment's result JSON is
 * deliberately NOT here: it is the one field that is large, and reading it for
 * every applicant to render 25 rows is the load this paging exists to stop.
 */
const SCAN_SELECT = {
  id: true, fullName: true, email: true, createdAt: true,
  pipelines: { select: { roleId: true, stagesJson: true, currentStageKey: true, decision: true, status: true, updatedAt: true } },
  interviews: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1,
    select: {
      id: true, roleId: true, state: true, durationMinutes: true, updatedAt: true, scheduledAt: true,
      assessments: {
        orderBy: { version: 'desc' }, take: 1,
        select: {
          id: true, recommendation: true,
          scorecard: { select: { version: true } },
          reviews: {
            where: { status: 'COMPLETED', supersededAt: null },
            orderBy: { completedAt: 'desc' }, take: 1,
            select: { disposition: true, completedAt: true },
          },
        },
      },
    },
  },
} satisfies Prisma.CandidateSelect;

type ScanRow = Prisma.CandidateGetPayload<{ select: typeof SCAN_SELECT }>;

export interface RoleCandidateStage {
  readonly key: string;
  readonly label: string;
  /** 1-based position in the role's stage plan; null when the plan does not name this stage. */
  readonly order: number | null;
  /**
   * A decided pipeline, said in the one vocabulary (Proceed / Consider / Do
   * not progress / Candidate withdrew) — never the stored APPROVED / REJECTED
   * / WITHDRAWN enum, which is a storage detail that must not reach a sentence
   * a person reads. Null while the pipeline is still running, and withheld
   * with everything else from a viewer who owes their own blind verdict: a
   * decision is a colleague's judgement and anchors exactly as hard.
   */
  readonly outcome: string | null;
}

/** What the assessment's stored result says, read only for the rows that need it. */
export interface AssessmentFacts {
  readonly overallScore: number | null;
  readonly competenciesGraded: number;
}

export interface RoleCandidateRow {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly stage: RoleCandidateStage | null;
  readonly latestInterview: { readonly id: string; readonly state: string } | null;
  readonly assessmentId: string | null;
  /** Absent while the blind-review policy still holds this viewer back. */
  readonly recommendation?: string | null;
  readonly humanRecommendation?: string | null;
  readonly blindReviewPending?: boolean;
  readonly overallScore?: number | null;
  readonly scorecardVersion: number | null;
  readonly competenciesGraded: number | null;
  readonly durationMinutes: number | null;
  readonly lastMovedAt: Date;
  readonly shortlisted: boolean;
  /** Where this candidate's figures were not produced like the others' here. */
  readonly comparability: readonly ComparabilityNote[];
}

export interface RoleCandidatesPage {
  readonly candidates: readonly RoleCandidateRow[];
  readonly meta: PageMeta;
  readonly sort: { readonly key: SortKey; readonly dir: SortDirection };
  /** How many of this role's candidates this viewer has ticked, across every page. */
  readonly shortlistedTotal: number;
}

/** The role's applications this caller may see; AND, so the role can only narrow the scope. */
export async function roleCandidateWhere(auth: AuthClaims, roleId: string): Promise<Prisma.CandidateWhereInput> {
  const scope = (await candidateScope(auth)) as Prisma.CandidateWhereInput;
  return { AND: [scope, { roleId }] };
}

/** The candidate's latest session for THIS role, ignoring any for another one. */
function sessionFor(row: ScanRow, roleId: string) {
  const session = row.interviews[0];
  return session && session.roleId === roleId ? session : null;
}

function pipelineFor(row: ScanRow, roleId: string) {
  return row.pipelines.find((p) => p.roleId === roleId) ?? null;
}

/**
 * A stored decision said in the one vocabulary, or null.
 *
 * Checked against the enum rather than cast into it: `outcomeLabel` answers
 * "Candidate withdrew" for anything it does not recognise, so an unexpected
 * value would have the page state, in plain words, that someone withdrew when
 * nobody did.
 */
function decisionOutcome(decision: string | null): string | null {
  if (!decision || !(DECISION_OUTCOMES as readonly string[]).includes(decision)) return null;
  return outcomeLabel(decision as DecisionOutcome);
}

function stageOf(row: ScanRow, roleId: string, withheld: boolean): RoleCandidateStage | null {
  const pipeline = pipelineFor(row, roleId);
  if (!pipeline) return null;
  const stages = parseStages(pipeline.stagesJson);
  const index = stages.findIndex((s) => s.key === pipeline.currentStageKey);
  // A stage the snapshotted plan does not name has no position in it. Zero
  // would sort as a real stage — before every named one — and quietly move the
  // row to the head of a "furthest along" sort.
  return {
    key: pipeline.currentStageKey,
    label: index >= 0 ? stages[index].label : pipeline.currentStageKey,
    order: index >= 0 ? index + 1 : null,
    outcome: withheld ? null : decisionOutcome(pipeline.decision),
  };
}

/** When this application last moved: its pipeline, its interview, or the day it arrived. */
function lastMovedAt(row: ScanRow, roleId: string): Date {
  const pipeline = pipelineFor(row, roleId);
  const session = sessionFor(row, roleId);
  const times = [row.createdAt, pipeline?.updatedAt, session?.updatedAt].filter((t): t is Date => t instanceof Date);
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

/**
 * The stored result, for the assessments actually needed.
 *
 * Called for the whole pipeline only when the sort is by score — that is the
 * one order that cannot be decided without reading every assessment — and for
 * the page's rows otherwise.
 */
export async function assessmentFacts(assessmentIds: readonly string[]): Promise<Map<string, AssessmentFacts>> {
  if (!assessmentIds.length) return new Map();
  const rows = await prisma.assessmentVersion.findMany({
    where: { id: { in: [...assessmentIds] } },
    select: { id: true, resultJson: true },
  });
  return new Map(rows.map((r) => {
    const result = parseJsonOptional<Partial<AssessmentResult>>(r.resultJson, {}, { model: 'AssessmentVersion', id: r.id, field: 'resultJson' });
    const score = typeof result.overallScore === 'number' && Number.isFinite(result.overallScore) ? result.overallScore : null;
    return [r.id, { overallScore: score, competenciesGraded: (result.competencies ?? []).length }];
  }));
}

/** One scoped row with everything the three comparison views decide from. */
export interface PreparedCandidate {
  readonly row: ScanRow;
  readonly sortable: SortableCandidate;
  readonly stage: RoleCandidateRow['stage'];
  readonly latestInterview: RoleCandidateRow['latestInterview'];
  readonly durationMinutes: number | null;
  readonly assessmentId: string | null;
  readonly scorecardVersion: number | null;
  readonly aiRecommendation: string | null;
  readonly human: string | null;
  /** True when the blind-review policy still withholds this candidate's AI conclusions from this viewer. */
  readonly withheld: boolean;
}

/**
 * Every row this caller may see for the role, with the blind-review policy
 * already applied.
 *
 * Withholding BEFORE the sort is the point: a verdict this viewer may not see
 * must not be allowed to decide where its row lands, or the order itself
 * reports the verdict the page is refusing to print.
 */
export async function prepareRoleCandidates(
  auth: AuthClaims,
  roleId: string,
  query: { readonly q?: string },
): Promise<PreparedCandidate[]> {
  const rows = await prisma.candidate.findMany({
    where: await roleCandidateWhere(auth, roleId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: SCAN_SELECT,
  });
  const needle = query.q ? foldText(query.q) : '';
  const matched = needle ? rows.filter((r) => anyFieldMatches(needle, [r.fullName, r.email])) : rows;

  const assessmentIds = matched.flatMap((r) => {
    const session = sessionFor(r, roleId);
    return session?.assessments[0] ? [session.assessments[0].id] : [];
  });
  const visible = await aiConclusionVisible({
    assessmentIds, userId: auth.userId, canReview: hasCapability(auth, 'assessment:review'), tenantId: auth.tenantId,
  });

  return matched.map((row) => {
    const session = sessionFor(row, roleId);
    const assessment = session?.assessments[0] ?? null;
    const withheld = assessment !== null && !visible.has(assessment.id);
    const human = withheld ? null : humanVerdict(assessment?.reviews[0]?.disposition);
    const ai = withheld ? null : assessment?.recommendation ?? null;
    const stage = stageOf(row, roleId, withheld);
    return {
      row,
      stage,
      latestInterview: session ? { id: session.id, state: session.state } : null,
      durationMinutes: session?.durationMinutes ?? null,
      assessmentId: assessment?.id ?? null,
      scorecardVersion: assessment?.scorecard.version ?? null,
      aiRecommendation: ai,
      human,
      withheld,
      sortable: {
        id: row.id,
        name: row.fullName,
        verdict: human ?? ai,
        // Filled in below only when the sort needs it; null keeps a row with no
        // score at the foot, which is where a missing measurement belongs.
        score: null,
        stageOrder: stage?.order ?? null,
        movedAt: lastMovedAt(row, roleId).getTime(),
      },
    };
  });
}

/** One page of the role's candidates, ordered by the key the caller asked for. */
export async function listRoleCandidates(
  auth: AuthClaims,
  roleId: string,
  query: RoleCandidatesQuery,
): Promise<RoleCandidatesPage> {
  const prepared = await prepareRoleCandidates(auth, roleId, query);

  // Sorting by score is the one order that has to read every assessment.
  const scoringAll = query.sort === 'score';
  const facts = await assessmentFacts(scoringAll ? prepared.flatMap((p) => (p.assessmentId && !p.withheld ? [p.assessmentId] : [])) : []);
  const sortable = prepared.map((p) => ({
    ...p.sortable,
    score: p.assessmentId && !p.withheld ? facts.get(p.assessmentId)?.overallScore ?? null : null,
  }));

  const ordered = sortCandidates(sortable, query.sort, query.dir);
  const skip = skipFor(query);
  const pageIds = ordered.slice(skip, skip + query.pageSize).map((s) => s.id);
  const byId = new Map(prepared.map((p) => [p.row.id, p]));
  const page = pageIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));

  const pageFacts = scoringAll
    ? facts
    : await assessmentFacts(page.flatMap((p) => (p.assessmentId && !p.withheld ? [p.assessmentId] : [])));
  const shortlisted = await shortlistedIds(auth, roleId);
  const notes = comparabilityNotes(page.map((p) => ({
    candidateId: p.row.id,
    scorecardVersion: p.withheld ? null : p.scorecardVersion,
    competenciesGraded: p.assessmentId ? pageFacts.get(p.assessmentId)?.competenciesGraded ?? null : null,
    durationMinutes: p.durationMinutes,
  })));

  return {
    candidates: page.map((p) => shapeRow(p, pageFacts, shortlisted, notes)),
    meta: pageMeta(ordered.length, query),
    sort: { key: query.sort, dir: query.dir },
    shortlistedTotal: [...shortlisted].filter((id) => byId.has(id)).length,
  };
}

function shapeRow(
  p: PreparedCandidate,
  facts: ReadonlyMap<string, AssessmentFacts>,
  shortlisted: ReadonlySet<string>,
  notes: ReadonlyMap<string, readonly ComparabilityNote[]>,
): RoleCandidateRow {
  const fact = p.assessmentId ? facts.get(p.assessmentId) : undefined;
  // A colleague's verdict is held back with the AI's: either would bias the
  // independent review the policy is still waiting for.
  const conclusion = p.withheld
    ? { blindReviewPending: true as const }
    : { recommendation: p.aiRecommendation, humanRecommendation: p.human, overallScore: fact?.overallScore ?? null };
  return {
    id: p.row.id,
    fullName: p.row.fullName,
    email: p.row.email,
    stage: p.stage,
    latestInterview: p.latestInterview,
    assessmentId: p.assessmentId,
    ...conclusion,
    scorecardVersion: p.withheld ? null : p.scorecardVersion,
    competenciesGraded: p.withheld ? null : fact?.competenciesGraded ?? null,
    durationMinutes: p.durationMinutes,
    // The same instant the recency sort used, not a second reading of it: two
    // computations of "when did this move" are two answers waiting to differ.
    lastMovedAt: new Date(p.sortable.movedAt),
    shortlisted: shortlisted.has(p.row.id),
    comparability: notes.get(p.row.id) ?? [],
  };
}

// ---------------------------------------------------------------------------
// The shortlist
// ---------------------------------------------------------------------------

/** How many candidates one person may hold side by side. Four columns is what a screen reads. */
export const MAX_SHORTLIST = 4;
export const MIN_COMPARISON = 2;

/** This caller's shortlist for this role. Scoped, so a tick on a candidate they lost access to is not returned. */
export async function shortlistedIds(auth: AuthClaims, roleId: string): Promise<ReadonlySet<string>> {
  const rows = await prisma.candidateShortlist.findMany({
    where: { roleId, userId: auth.userId, tenantId: auth.tenantId, candidate: await roleCandidateWhere(auth, roleId) },
    select: { candidateId: true },
  });
  return new Set(rows.map((r) => r.candidateId));
}
