import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { normalizeTitle } from '../domain/catalogText.js';
import { isCatalogRefreshActive } from './catalogRefreshRun.js';
import { parseStats } from './catalogRefreshState.js';
import { PROPOSAL_INCLUDE, shapeProposal } from './catalogProposalShape.js';

/** Read side of the review page: the filtered queue and the recent runs. */

export interface ProposalQuery {
  readonly status?: 'pending' | 'approved' | 'rejected' | 'superseded';
  readonly kind?: 'new_role' | 'new_alias';
  readonly domainId?: string;
  readonly source?: 'onet' | 'esco' | 'web';
  readonly q: string;
  readonly page: number;
  readonly limit: number;
}

function searchFilter(q: string): Prisma.CatalogProposalWhereInput[] {
  const text = q.trim();
  if (!text) return [];
  // Portable across SQLite and Postgres without `mode: 'insensitive'`:
  // titles are matched in their normalised form, summaries as typed and in
  // lower case (summaries are sentences, mostly lower case).
  const normalized = normalizeTitle(text);
  return [{
    OR: [
      ...(normalized ? [{ normalizedTitle: { contains: normalized } }] : []),
      { summary: { contains: text } },
      { summary: { contains: text.toLowerCase() } },
    ],
  }];
}

export function proposalWhere(query: ProposalQuery): Prisma.CatalogProposalWhereInput {
  return {
    AND: [
      ...(query.status ? [{ status: query.status }] : []),
      ...(query.kind ? [{ kind: query.kind }] : []),
      ...(query.domainId ? [{ domainId: query.domainId }] : []),
      // The source is an enum value, and sourcesJson is written by
      // JSON.stringify, so this exact fragment appears only for that source.
      ...(query.source ? [{ sourcesJson: { contains: `"source":"${query.source}"` } }] : []),
      ...searchFilter(query.q),
    ],
  };
}

export async function listProposals(query: ProposalQuery) {
  const where = proposalWhere(query);
  const [total, pending, rows] = await Promise.all([
    prisma.catalogProposal.count({ where }),
    prisma.catalogProposal.count({ where: { status: 'pending' } }),
    prisma.catalogProposal.findMany({
      where, include: PROPOSAL_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { confidence: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.limit, take: query.limit,
    }),
  ]);
  return {
    proposals: rows.map(shapeProposal),
    meta: { total, page: query.page, limit: query.limit, totalPages: Math.max(1, Math.ceil(total / query.limit)), pendingTotal: pending },
  };
}

export const RECENT_RUNS = 20;

export async function listRuns() {
  const [runs, active] = await Promise.all([
    prisma.catalogRefreshRun.findMany({
      orderBy: { startedAt: 'desc' }, take: RECENT_RUNS,
      include: { _count: { select: { proposals: true } }, triggeredBy: { select: { name: true } } },
    }),
    isCatalogRefreshActive(new Date()),
  ]);
  return {
    active,
    runs: runs.map((run) => ({
      id: run.id, status: run.status, trigger: run.trigger, triggeredBy: run.triggeredBy?.name ?? null,
      startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
      stats: parseStats(run.statsJson), llmCalls: run.llmCalls, researchCalls: run.researchCalls, error: run.error, proposals: run._count.proposals,
    })),
  };
}

/** Domains and the families their roles use: the choices an edit may make. */
export async function editOptions() {
  const [domains, families, used] = await Promise.all([
    prisma.catalogDomain.findMany({ where: { status: 'active' }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
    prisma.catalogJobFamily.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
    prisma.catalogRole.findMany({ where: { status: 'active', familyId: { not: null } }, distinct: ['domainId', 'familyId'], select: { domainId: true, familyId: true } }),
  ]);
  return {
    domains: domains.map((domain) => {
      const inDomain = new Set(used.filter((row) => row.domainId === domain.id).map((row) => row.familyId));
      return { ...domain, families: families.filter((family) => inDomain.has(family.id)) };
    }),
  };
}
