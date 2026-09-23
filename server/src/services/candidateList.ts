import type { Prisma } from '@prisma/client';
import { prisma, parseJsonOptional } from '../db.js';
import { candidateScope, roleScope } from './access.js';
import type { AuthClaims } from './auth.js';
import { parseStages } from '../domain/pipelineStages.js';
import { anyFieldMatches, foldText, pageMeta, skipFor, type PageMeta, type Paging } from './listPaging.js';
import { memoBriefly, shapeKey } from './listCache.js';

/**
 * One page of the Candidates list.
 *
 * Search is matched in application code over a narrow scan (name, address,
 * role title), not with SQL LIKE: Prisma's `mode: 'insensitive'` does not exist
 * on SQLite and Postgres LIKE is case-sensitive, so the same search would find
 * different people in development and production (see roleSearch.ts). Only the
 * page's rows are then read in full.
 */

export interface CandidateListQuery extends Paging {
  readonly roleId?: string;
  readonly q?: string;
}

const ORDER: Prisma.CandidateOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

const ROW_SELECT = {
  id: true, fullName: true, email: true, roleId: true, createdAt: true,
  role: { select: { title: true, level: true, regionCode: true, experienceBand: true, createdAt: true } },
  profiles: { orderBy: { version: 'desc' }, take: 1, select: { id: true, fitScoreJson: true } },
  interviews: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true, state: true } },
  pipelines: { select: { roleId: true, stagesJson: true, currentStageKey: true, decision: true } },
} satisfies Prisma.CandidateSelect;

type Row = Prisma.CandidateGetPayload<{ select: typeof ROW_SELECT }>;

export interface ListRole {
  readonly id: string;
  readonly title: string;
  readonly level: string | null;
  readonly regionCode: string | null;
  readonly experienceBand: string | null;
  readonly createdAt: Date;
}

export interface CandidateListPage {
  readonly candidates: readonly Record<string, unknown>[];
  readonly meta: PageMeta;
  /** Every same-titled role in scope, so a page can label its roles apart. */
  readonly roles: readonly ListRole[];
  /** Candidates by their latest interview's state, across every page. */
  readonly summary: { readonly latestStateCounts: Record<string, number> };
}

/**
 * The roles in scope whose title matches, by id. A tenant has tens of roles,
 * not thousands, so this is one small read however many candidates there are —
 * and it means the candidate scan does not have to carry a role join.
 */
async function matchingRoleIds(where: Prisma.CandidateWhereInput, needle: string): Promise<ReadonlySet<string>> {
  const roles = await prisma.role.findMany({ where: { candidates: { some: where } }, select: { id: true, title: true } });
  return new Set(roles.filter((r) => anyFieldMatches(needle, [r.title])).map((r) => r.id));
}

/**
 * Every candidate in scope the search matches, newest first, as ids.
 *
 * Matched in the application because `mode: 'insensitive'` does not exist on
 * SQLite and Postgres LIKE is case-sensitive, so the same search would find
 * different people in development and production — the reason this scan exists
 * at all. What it no longer does is join a role per candidate: that made it a
 * 5,000-row join for at most a few dozen distinct titles, and the titles are
 * one small read (§2.2 attributed 324 ms of the search to this scan).
 *
 * Held for a few seconds, so paging through the results and a re-render do not
 * each rerun it.
 */
async function matchingIds(where: Prisma.CandidateWhereInput, needle: string): Promise<readonly string[]> {
  return memoBriefly(`candidates:search:${shapeKey([where, needle])}`, async () => {
    const [narrow, titles] = await Promise.all([
      prisma.candidate.findMany({ where, orderBy: ORDER, select: { id: true, fullName: true, email: true, roleId: true } }),
      matchingRoleIds(where, needle),
    ]);
    return narrow
      .filter((c) => (c.roleId !== null && titles.has(c.roleId)) || anyFieldMatches(needle, [c.fullName, c.email]))
      .map((c) => c.id);
  });
}

async function pageRows(where: Prisma.CandidateWhereInput, query: CandidateListQuery): Promise<{ total: number; rows: Row[] }> {
  const skip = skipFor(query);
  const needle = query.q ? foldText(query.q) : '';
  if (!needle) {
    const total = await prisma.candidate.count({ where });
    // Past the last page there is nothing to read.
    const rows = skip >= total ? [] : await prisma.candidate.findMany({ where, orderBy: ORDER, skip, take: query.pageSize, select: ROW_SELECT });
    return { total, rows };
  }
  const matched = await matchingIds(where, needle);
  const ids = matched.slice(skip, skip + query.pageSize).map((id) => id);
  const rows = ids.length
    // The scope again, not only the ids: the read that returns detail never relies on
    // the scan before it having been scoped.
    ? await prisma.candidate.findMany({ where: { AND: [where, { id: { in: ids } }] }, orderBy: ORDER, select: ROW_SELECT })
    : [];
  return { total: matched.length, rows };
}

const emailKey = (email: string): string => email.trim().toLowerCase();

/**
 * For each row, how many OTHER roles the same address is in — among the
 * caller's scoped applications only, so a role they cannot see is never counted.
 */
async function otherRoleCounts(scope: Prisma.CandidateWhereInput, rows: readonly Row[]): Promise<Map<string, number>> {
  if (!rows.length) return new Map();
  const emails = [...new Set(rows.map((r) => r.email))];
  const keys = [...new Set(emails.map(emailKey))];
  const peers = await prisma.candidate.findMany({
    where: { AND: [scope, { OR: [{ emailNormalized: { in: keys } }, { email: { in: emails } }] }] },
    select: { email: true, roleId: true },
  });
  const rolesByEmail = peers.reduce((acc, peer) => {
    const key = emailKey(peer.email);
    const roles = acc.get(key) ?? new Set<string>();
    return acc.set(key, peer.roleId ? new Set([...roles, peer.roleId]) : roles);
  }, new Map<string, ReadonlySet<string>>());
  return new Map(rows.map((row) => {
    const roles = rolesByEmail.get(emailKey(row.email)) ?? new Set<string>();
    return [row.id, roles.size - (row.roleId && roles.has(row.roleId) ? 1 : 0)];
  }));
}

/** Scoped roles sharing a title with a role on this page. */
async function rolesForLabels(auth: AuthClaims, titles: readonly string[]): Promise<ListRole[]> {
  if (!titles.length) return [];
  const wanted = new Set(titles.map((t) => foldText(t.trim())));
  const roles = await prisma.role.findMany({
    where: (await roleScope(auth)) as Prisma.RoleWhereInput,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, title: true, level: true, regionCode: true, experienceBand: true, createdAt: true },
  });
  return roles.filter((r) => wanted.has(foldText(r.title.trim())));
}

/**
 * How many candidates' latest interview sits in each state.
 *
 * This read every session in the tenant and deduplicated them in the
 * application: 20,000 rows and 582 ms of a 940 ms page, on every request,
 * whichever page was asked for (docs/qa/resilience-2026-09-23.md §2.2).
 *
 * `distinct` on candidateId, with candidateId leading the ordering, lets the
 * database do it: on PostgreSQL that is a DISTINCT ON walking
 * `[tenantId, candidateId, createdAt]` and taking the first row of each run, so
 * the rows that cross the wire are one per CANDIDATE rather than one per
 * INTERVIEW. The secondary ordering keeps the same row winning as before — the
 * newest session, ties broken by id.
 */
export async function latestStateCounts(tenantId: string, where: Prisma.CandidateWhereInput): Promise<Record<string, number>> {
  // Tenant-wide by definition, so it cannot be made to scale with the page.
  // Held for a few seconds instead, which is what stops ten operators
  // refreshing the list from running ten identical whole-tenant queries.
  return memoBriefly(`candidates:states:${shapeKey([tenantId, where])}`, async () => {
    const latest = await prisma.interviewSession.findMany({
      where: { tenantId, candidate: where },
      orderBy: [{ candidateId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['candidateId'],
      select: { state: true },
    });
    return latest.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.state]: (acc[s.state] ?? 0) + 1 }), {});
  });
}

/**
 * The pipeline stage this application has reached, named as its role names it
 * (stage plans are per role). One pipeline per candidate and role.
 */
function stageOf(c: Row): { key: string; label: string; decision: string | null } | null {
  const pipeline = c.pipelines.find((p) => p.roleId === c.roleId);
  if (!pipeline) return null;
  const stage = parseStages(pipeline.stagesJson).find((s) => s.key === pipeline.currentStageKey);
  return { key: pipeline.currentStageKey, label: stage?.label ?? pipeline.currentStageKey, decision: pipeline.decision ?? null };
}

function shapeRow(c: Row, alsoInRoles: number): Record<string, unknown> {
  const profile = c.profiles[0];
  return {
    id: c.id, fullName: c.fullName, email: c.email, roleId: c.roleId, roleTitle: c.role?.title ?? null,
    roleLevel: c.role?.level ?? null, roleRegionCode: c.role?.regionCode ?? null, roleExperienceBand: c.role?.experienceBand ?? null, roleCreatedAt: c.role?.createdAt ?? null,
    fit: profile ? parseJsonOptional<Record<string, unknown> | null>(profile.fitScoreJson, null, { model: 'CandidateProfileVersion', id: profile.id, field: 'fitScoreJson' }) : null,
    latestInterview: c.interviews[0] ? { id: c.interviews[0].id, state: c.interviews[0].state } : null,
    stage: stageOf(c),
    alsoInRoles,
    createdAt: c.createdAt,
  };
}

export async function listCandidates(auth: AuthClaims, query: CandidateListQuery): Promise<CandidateListPage> {
  const scope = (await candidateScope(auth)) as Prisma.CandidateWhereInput;
  // AND, never a spread: the role filter may only ever NARROW the caller's scope.
  const where: Prisma.CandidateWhereInput = { AND: [scope, ...(query.roleId ? [{ roleId: query.roleId }] : [])] };
  const { total, rows } = await pageRows(where, query);
  const titles = [...new Set(rows.flatMap((r) => (r.role?.title ? [r.role.title] : [])))];
  const [others, roles, stateCounts] = await Promise.all([
    otherRoleCounts(scope, rows),
    rolesForLabels(auth, titles),
    latestStateCounts(auth.tenantId, where),
  ]);
  return {
    candidates: rows.map((r) => shapeRow(r, others.get(r.id) ?? 0)),
    meta: pageMeta(total, query),
    roles,
    summary: { latestStateCounts: stateCounts },
  };
}
