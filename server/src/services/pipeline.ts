import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { candidateScope } from './access.js';
import type { AuthClaims } from './auth.js';

export interface PipelineSummary {
  readonly stateCounts: Readonly<Record<string, number>>;
  readonly total: number;
}

/**
 * Interview-session counts grouped by state.
 *
 * Sessions carry no scope of their own — they inherit their candidate's — so
 * this filters through the candidate relation using the same `candidateScope`
 * helper every other candidate-scoped query in this codebase uses, rather than
 * re-deriving assignment rules here. Shared by GET /api/interviews/pipeline-
 * summary and GET /api/admin/hr-dashboard so the two endpoints cannot drift
 * into two different definitions of "what this user may see".
 */
export async function getPipelineSummary(auth: AuthClaims, roleId?: string): Promise<PipelineSummary> {
  const scope = (await candidateScope(auth)) as Prisma.CandidateWhereInput;
  const rows = await prisma.interviewSession.groupBy({
    by: ['state'],
    where: { tenantId: auth.tenantId, ...(roleId ? { roleId } : {}), candidate: scope },
    _count: { _all: true },
  });
  const stateCounts = Object.fromEntries(rows.map((row) => [row.state, row._count._all]));
  const total = rows.reduce((sum, row) => sum + row._count._all, 0);
  return { stateCounts, total };
}
