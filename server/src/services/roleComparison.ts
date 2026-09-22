import { z } from 'zod';
import { prisma, parseJsonOptional } from '../db.js';
import { HttpError } from '../middleware/index.js';
import type { AuthClaims } from './auth.js';
import { humanVerdict, applyReviewOverrides, type CompletedReview, type ReviewOverride } from '../domain/reviewedAssessment.js';
import { gridCell, comparabilityNotes, sortCandidates, type ComparabilityNote, type GridCell } from '../domain/candidateComparison.js';
import type { AssessmentResult, Competency, CompetencyScore, RoleSuccessProfile } from '../domain/types.js';
import { latestScorecard, profileOf } from './scorecardVersions.js';
import { pageMeta, skipFor, type PageMeta } from './listPaging.js';
import {
  MAX_SHORTLIST,
  MIN_COMPARISON,
  assessmentFacts,
  prepareRoleCandidates,
  shortlistedIds,
  type RoleCandidatesQuery,
} from './roleCandidates.js';

/**
 * The two comparison views on the role page: the skills grid across every
 * candidate, and the side-by-side of the two to four a reviewer has shortlisted.
 *
 * Both read the SAME rows, in the same order, as the candidates table above
 * them (services/roleCandidates.ts), and both apply the blind-review policy to
 * each candidate separately: an organisation that asks for blind review gets a
 * comparison with one column withheld, not a comparison that quietly leaks the
 * AI's call for the candidate this reviewer has not yet judged.
 */

// ---------------------------------------------------------------------------
// Competencies: the grid's columns
// ---------------------------------------------------------------------------

export interface GridCompetency {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly requiredLevel: number;
  readonly targetLevel: number;
  readonly weight: number;
}

/**
 * The columns: the role's scored competencies as its newest scorecard defines
 * them. A retired competency is left out — it is kept so an old assessment can
 * still resolve its name, not so it can take a column nobody is hiring against.
 */
export function gridCompetencies(profile: RoleSuccessProfile): GridCompetency[] {
  return (profile.competencies ?? [])
    .filter((c: Competency) => !c.retired && c.classification !== 'non_scoring')
    .map((c) => ({
      id: c.id, name: c.name, category: c.category,
      requiredLevel: c.requiredLevel ?? 0, targetLevel: c.targetLevel ?? 0, weight: c.weight ?? 0,
    }));
}

// ---------------------------------------------------------------------------
// Reading one candidate's assessment
// ---------------------------------------------------------------------------

interface ReadAssessment {
  readonly id: string;
  readonly result: AssessmentResult;
  readonly review: CompletedReview | null;
}

/** The stored results for these assessments, with any completed review applied. */
async function readAssessments(assessmentIds: readonly string[]): Promise<Map<string, ReadAssessment>> {
  if (!assessmentIds.length) return new Map();
  const rows = await prisma.assessmentVersion.findMany({
    where: { id: { in: [...assessmentIds] } },
    select: {
      id: true, resultJson: true,
      reviews: {
        where: { status: 'COMPLETED', supersededAt: null },
        orderBy: { completedAt: 'desc' }, take: 1,
        select: { id: true, reviewerId: true, disposition: true, reason: true, comments: true, completedAt: true, overridesJson: true },
      },
    },
  });
  return new Map(rows.map((row) => {
    const ref = { model: 'AssessmentVersion', id: row.id, field: 'resultJson' };
    const result = parseJsonOptional<AssessmentResult>(row.resultJson, EMPTY_RESULT, ref);
    const stored = row.reviews[0];
    const review: CompletedReview | null = stored ? {
      id: stored.id, reviewerId: stored.reviewerId, disposition: stored.disposition,
      reason: stored.reason, comments: stored.comments, completedAt: stored.completedAt,
      overrides: parseJsonOptional<ReviewOverride[]>(stored.overridesJson, [], { model: 'HumanReview', id: stored.id, field: 'overridesJson' }),
    } : null;
    return [row.id, { id: row.id, result, review }];
  }));
}

const EMPTY_RESULT: AssessmentResult = {
  assessmentVersion: '', roleScorecardVersion: '', recommendation: 'CONSIDER', confidence: 0,
  evidenceCoverage: 0, overallScore: null, competencies: [], strengths: [], concerns: [],
  contradictions: [], openQuestions: [], limitations: [], summary: '',
};

/** The levels the team acts on: the reviewer's where they recorded one, the AI's otherwise. */
function actedOn(read: ReadAssessment): AssessmentResult {
  return applyReviewOverrides(read.result, read.review);
}

function scoresById(result: AssessmentResult): Map<string, CompetencyScore> {
  return new Map((result.competencies ?? []).map((c) => [c.id, c]));
}

// ---------------------------------------------------------------------------
// The skills grid
// ---------------------------------------------------------------------------

export interface GridRow {
  readonly candidateId: string;
  readonly fullName: string;
  readonly assessmentId: string | null;
  /** Withheld while this viewer's own verdict is owed; the row then carries no cells. */
  readonly blindReviewPending?: boolean;
  /** Whose levels these are, said in words rather than left to a colour. */
  readonly levelSource: 'human' | 'ai' | null;
  readonly cells: Readonly<Record<string, GridCell>>;
  readonly comparability: readonly ComparabilityNote[];
}

export interface CompetencyGrid {
  readonly competencies: readonly GridCompetency[];
  readonly rows: readonly GridRow[];
  readonly meta: PageMeta;
  readonly scorecardVersion: number;
}

export async function roleCompetencyGrid(
  auth: AuthClaims,
  roleId: string,
  query: RoleCandidatesQuery,
): Promise<CompetencyGrid> {
  const scorecard = await latestScorecard(roleId);
  const competencies = gridCompetencies(profileOf(scorecard));

  const prepared = await prepareRoleCandidates(auth, roleId, query);
  const scoringAll = query.sort === 'score';
  const preFacts = await assessmentFacts(scoringAll ? prepared.flatMap((p) => (p.assessmentId && !p.withheld ? [p.assessmentId] : [])) : []);
  const ordered = sortCandidates(
    prepared.map((p) => ({ ...p.sortable, score: p.assessmentId && !p.withheld ? preFacts.get(p.assessmentId)?.overallScore ?? null : null })),
    query.sort, query.dir,
  );
  const skip = skipFor(query);
  const byId = new Map(prepared.map((p) => [p.row.id, p]));
  const page = ordered.slice(skip, skip + query.pageSize).flatMap((s) => (byId.has(s.id) ? [byId.get(s.id)!] : []));

  const reads = await readAssessments(page.flatMap((p) => (p.assessmentId && !p.withheld ? [p.assessmentId] : [])));
  const notes = comparabilityNotes(page.map((p) => {
    const read = p.assessmentId ? reads.get(p.assessmentId) : undefined;
    return {
      candidateId: p.row.id,
      scorecardVersion: p.withheld ? null : p.scorecardVersion,
      competenciesGraded: read ? (read.result.competencies ?? []).length : null,
      durationMinutes: p.durationMinutes,
    };
  }));

  const rows: GridRow[] = page.map((p) => {
    const read = p.assessmentId && !p.withheld ? reads.get(p.assessmentId) : undefined;
    if (!read) {
      return {
        candidateId: p.row.id, fullName: p.row.fullName, assessmentId: p.assessmentId,
        ...(p.withheld ? { blindReviewPending: true } : {}),
        levelSource: null, cells: {}, comparability: notes.get(p.row.id) ?? [],
      };
    }
    const scored = scoresById(actedOn(read));
    return {
      candidateId: p.row.id, fullName: p.row.fullName, assessmentId: p.assessmentId,
      levelSource: read.review ? 'human' : 'ai',
      cells: Object.fromEntries(competencies.map((c) => [c.id, gridCell(scored.get(c.id))])),
      comparability: notes.get(p.row.id) ?? [],
    };
  });

  return { competencies, rows, meta: pageMeta(ordered.length, query), scorecardVersion: scorecard.version };
}

// ---------------------------------------------------------------------------
// Side by side
// ---------------------------------------------------------------------------

export const comparisonQuerySchema = z.object({
  // Repeated ?ids=a&ids=b arrives as an array; one comma-separated value keeps
  // the shape the same however the browser sends it.
  ids: z.string().min(1).max(400).transform((raw) => raw.split(',').map((s) => s.trim()).filter(Boolean)),
}).strict();

export interface ComparedEvidence {
  readonly quote: string;
  readonly turnId: string;
  readonly startMs: number;
}

export interface ComparedCompetency {
  readonly id: string;
  readonly cell: GridCell;
  readonly rationale: string;
  /** The strongest couple of quotes; the assessment holds the rest. */
  readonly evidence: readonly ComparedEvidence[];
}

export interface ComparedCandidate {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly stage: { readonly key: string; readonly label: string; readonly decision: string | null } | null;
  readonly latestInterview: { readonly id: string; readonly state: string } | null;
  readonly assessmentId: string | null;
  readonly blindReviewPending?: boolean;
  /** What the AI recommended; absent while this viewer's own verdict is owed. */
  readonly recommendation?: string | null;
  /** The completed review's verdict, in the one vocabulary. */
  readonly humanRecommendation?: string | null;
  readonly overallScore?: number | null;
  readonly levelSource: 'human' | 'ai' | null;
  readonly competencies: readonly ComparedCompetency[];
  /** The next interview booked for this candidate on this role, if one is. */
  readonly nextRoundAt: Date | null;
  readonly nextRoundTimeZone: string | null;
  readonly comparability: readonly ComparabilityNote[];
}

export interface ComparisonPayload {
  readonly competencies: readonly GridCompetency[];
  readonly candidates: readonly ComparedCandidate[];
  readonly scorecardVersion: number;
  /**
   * Questor does not record a candidate's notice period or availability, so
   * the page says so rather than leaving a manager to read an empty row as
   * "available now".
   */
  readonly availabilityRecorded: false;
}

const MAX_EVIDENCE_PER_COMPETENCY = 2;

export async function compareCandidates(
  auth: AuthClaims,
  roleId: string,
  candidateIds: readonly string[],
): Promise<ComparisonPayload> {
  const wanted = [...new Set(candidateIds)];
  if (wanted.length < MIN_COMPARISON) {
    throw new HttpError(400, `Pick at least ${MIN_COMPARISON} candidates to compare.`);
  }
  if (wanted.length > MAX_SHORTLIST) {
    throw new HttpError(400, `Up to ${MAX_SHORTLIST} candidates can be compared side by side.`);
  }

  const scorecard = await latestScorecard(roleId);
  const competencies = gridCompetencies(profileOf(scorecard));

  // Scoped like every other read of this role: an id the caller may not see is
  // simply not among the rows, so the comparison cannot be used to confirm one.
  const prepared = await prepareRoleCandidates(auth, roleId, {});
  const byId = new Map(prepared.map((p) => [p.row.id, p]));
  const chosen = wanted.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  if (chosen.length < MIN_COMPARISON) {
    throw new HttpError(404, 'Those candidates are not on this role, or are not yours to see.');
  }

  const reads = await readAssessments(chosen.flatMap((p) => (p.assessmentId && !p.withheld ? [p.assessmentId] : [])));
  const rounds = await nextRounds(roleId, chosen.map((p) => p.row.id));
  const notes = comparabilityNotes(chosen.map((p) => {
    const read = p.assessmentId ? reads.get(p.assessmentId) : undefined;
    return {
      candidateId: p.row.id,
      scorecardVersion: p.withheld ? null : p.scorecardVersion,
      competenciesGraded: read ? (read.result.competencies ?? []).length : null,
      durationMinutes: p.durationMinutes,
    };
  }));

  const candidates: ComparedCandidate[] = chosen.map((p) => {
    const read = p.assessmentId && !p.withheld ? reads.get(p.assessmentId) : undefined;
    const applied = read ? actedOn(read) : null;
    const scored = applied ? scoresById(applied) : new Map<string, CompetencyScore>();
    const round = rounds.get(p.row.id) ?? null;
    return {
      id: p.row.id,
      fullName: p.row.fullName,
      email: p.row.email,
      stage: p.stage ? { key: p.stage.key, label: p.stage.label, decision: p.stage.decision } : null,
      latestInterview: p.latestInterview,
      assessmentId: p.assessmentId,
      ...(p.withheld
        ? { blindReviewPending: true as const }
        : { recommendation: p.aiRecommendation, humanRecommendation: p.human, overallScore: applied?.overallScore ?? read?.result.overallScore ?? null }),
      levelSource: read ? (read.review ? 'human' : 'ai') : null,
      competencies: read ? competencies.map((c) => shapeCompetency(c.id, scored.get(c.id))) : [],
      nextRoundAt: round?.scheduledAt ?? null,
      nextRoundTimeZone: round?.scheduledTimeZone ?? null,
      comparability: notes.get(p.row.id) ?? [],
    };
  });

  return { competencies, candidates, scorecardVersion: scorecard.version, availabilityRecorded: false };
}

function shapeCompetency(id: string, scored: CompetencyScore | undefined): ComparedCompetency {
  return {
    id,
    cell: gridCell(scored),
    rationale: scored?.rationale ?? '',
    evidence: (scored?.evidence ?? []).slice(0, MAX_EVIDENCE_PER_COMPETENCY).map((e) => ({
      quote: e.quote, turnId: e.turnId, startMs: e.startMs,
    })),
  };
}

/** The next interview booked at any stage of this role's pipeline, per candidate. */
async function nextRounds(roleId: string, candidateIds: readonly string[]) {
  if (!candidateIds.length) return new Map<string, { scheduledAt: Date; scheduledTimeZone: string | null }>();
  const rows = await prisma.interviewRound.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledAt: { gte: new Date() },
      pipeline: { roleId, candidateId: { in: [...candidateIds] } },
    },
    orderBy: { scheduledAt: 'asc' },
    select: { scheduledAt: true, scheduledTimeZone: true, pipeline: { select: { candidateId: true } } },
  });
  return rows.reduce((acc, row) => (
    acc.has(row.pipeline.candidateId) ? acc : acc.set(row.pipeline.candidateId, { scheduledAt: row.scheduledAt, scheduledTimeZone: row.scheduledTimeZone })
  ), new Map<string, { scheduledAt: Date; scheduledTimeZone: string | null }>());
}

export { MAX_SHORTLIST, MIN_COMPARISON, shortlistedIds };
