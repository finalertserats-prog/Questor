import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { candidateScope, hasCapability } from './access.js';
import type { AuthClaims } from './auth.js';
import { aiConclusionVisible } from './shadowMode.js';
import { humanVerdict } from '../domain/reviewedAssessment.js';
import { anyFieldMatches, foldText, pageMeta, pagingQuerySchema, skipFor, type PageMeta } from './listPaging.js';

/**
 * One page of the Interviews list. Paged, filtered and searched here rather
 * than in the browser; search is matched in application code over a narrow
 * scan for the reason given in candidateList.ts.
 */

const STATE_NAME = /^[A-Z_]{1,40}$/;
const MAX_STATES = 40;

export const interviewListQuerySchema = pagingQuerySchema.extend({
  // The web sends the raw states behind a display group ("stopped"), so the
  // group table lives in one place. Comma-separated and upper-case only.
  states: z.string().max(MAX_STATES * 41)
    .transform((raw) => raw.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(STATE_NAME, 'Unknown interview state')).max(MAX_STATES))
    .optional(),
  candidateId: z.string().min(1).max(64).optional(),
});

export type InterviewListQuery = z.infer<typeof interviewListQuerySchema>;

const ORDER: Prisma.InterviewSessionOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

const ROW_SELECT = {
  id: true, state: true, provider: true, scheduledAt: true, scheduledTimeZone: true, createdAt: true, candidateId: true, roleId: true,
  candidate: { select: { fullName: true } },
  role: { select: { title: true, level: true, regionCode: true, experienceBand: true, createdAt: true } },
  invitation: { select: { id: true } },
  assessments: {
    orderBy: { version: 'desc' }, take: 1,
    select: {
      id: true, recommendation: true,
      reviews: { where: { status: 'COMPLETED', supersededAt: null }, orderBy: { completedAt: 'desc' }, take: 1, select: { disposition: true } },
    },
  },
} satisfies Prisma.InterviewSessionSelect;

type Row = Prisma.InterviewSessionGetPayload<{ select: typeof ROW_SELECT }>;

export interface InterviewListPage {
  readonly sessions: readonly Record<string, unknown>[];
  readonly meta: PageMeta;
}

async function pageRows(where: Prisma.InterviewSessionWhereInput, query: InterviewListQuery): Promise<{ total: number; rows: Row[] }> {
  const skip = skipFor(query);
  const needle = query.q ? foldText(query.q) : '';
  if (!needle) {
    const total = await prisma.interviewSession.count({ where });
    const rows = skip >= total ? [] : await prisma.interviewSession.findMany({ where, orderBy: ORDER, skip, take: query.pageSize, select: ROW_SELECT });
    return { total, rows };
  }
  const narrow = await prisma.interviewSession.findMany({
    where, orderBy: ORDER, select: { id: true, candidate: { select: { fullName: true } }, role: { select: { title: true } } },
  });
  const matched = narrow.filter((s) => anyFieldMatches(needle, [s.candidate.fullName, s.role.title]));
  const ids = matched.slice(skip, skip + query.pageSize).map((s) => s.id);
  const rows = ids.length ? await prisma.interviewSession.findMany({ where: { id: { in: ids } }, orderBy: ORDER, select: ROW_SELECT }) : [];
  return { total: matched.length, rows };
}

export async function listInterviews(auth: AuthClaims, query: InterviewListQuery): Promise<InterviewListPage> {
  // Sessions have no scope of their own; they inherit the candidate's. Filtering
  // through the candidate relation keeps that single definition of scope.
  const scope = (await candidateScope(auth)) as Prisma.CandidateWhereInput;
  const where: Prisma.InterviewSessionWhereInput = {
    AND: [
      { tenantId: auth.tenantId, candidate: scope },
      ...(query.states?.length ? [{ state: { in: query.states } }] : []),
      ...(query.candidateId ? [{ candidateId: query.candidateId }] : []),
    ],
  };
  const { total, rows } = await pageRows(where, query);
  // The blind-review policy applies here as on the assessment page: a reviewer
  // it still holds back gets the assessment id, to reach the blind review, but
  // not the AI's call.
  const visible = await aiConclusionVisible({
    assessmentIds: rows.flatMap((s) => s.assessments.map((a) => a.id)),
    userId: auth.userId, canReview: hasCapability(auth, 'assessment:review'), tenantId: auth.tenantId,
  });
  const sessions = rows.map((s) => {
    const latest = s.assessments[0];
    // A colleague's verdict is held back with the AI's: either would bias the
    // independent review the policy is waiting for.
    const conclusion = !latest ? { recommendation: null, humanRecommendation: null }
      : visible.has(latest.id)
        ? { recommendation: latest.recommendation, humanRecommendation: humanVerdict(latest.reviews[0]?.disposition) }
        : { blindReviewPending: true };
    return {
      id: s.id, state: s.state, provider: s.provider, scheduledAt: s.scheduledAt, scheduledTimeZone: s.scheduledTimeZone,
      candidate: { id: s.candidateId, name: s.candidate.fullName },
      role: { id: s.roleId, title: s.role.title, level: s.role.level, regionCode: s.role.regionCode, experienceBand: s.role.experienceBand, createdAt: s.role.createdAt },
      ...conclusion, assessmentId: latest?.id ?? null,
      invited: !!s.invitation, createdAt: s.createdAt,
    };
  });
  return { sessions, meta: pageMeta(total, query) };
}
