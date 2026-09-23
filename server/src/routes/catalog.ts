import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { BANDS, type BandId } from '../engines/experienceBands.js';
import { prisma, parseJsonStrict } from '../db.js';
import { asyncHandler, authenticate, HttpError, requireCapability } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { normalizeTitle } from '../domain/catalogText.js';
import { addCatalogRole, catalogTitleProblem } from '../services/catalogRoles.js';
import { assertNotDemoTenant } from '../services/demoAccess.js';
import { CATALOG_ATTRIBUTIONS } from '../domain/catalogAttribution.js';
import { getTenantBusinessAreas, scopedDomainIds } from '../services/businessAreas.js';
import { shouldScopeCatalog } from '../domain/orgOnboarding.js';

export const catalogRouter = Router();

// Public, before authenticate: the O*NET licence (CC BY 4.0) requires the
// attribution wherever its data is shown, including to visitors not signed in.
catalogRouter.get('/sources', (_req, res) => {
  res.json({ sources: CATALOG_ATTRIBUTIONS });
});

catalogRouter.use(authenticate);

/**
 * `scope` narrows the catalog to the organisation's own business areas, which
 * is the point of choosing them: a search across 35 domains and every title in
 * them is slower and noisier than a search across the four the organisation
 * hires in.
 *
 * `mine` is the default and `all` is always available to anyone signed in.
 * This is a view, never a boundary — the catalog is global and shared, and an
 * organisation that has chosen no areas (every organisation that existed
 * before onboarding) gets the unscoped result either way.
 */
const scopeSchema = z.enum(['mine', 'all']).default('mine');

const roleQuerySchema = z.object({
  domainId: z.string().cuid().optional(),
  q: z.string().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(25).default(10),
  scope: scopeSchema,
}).strict();

const techStackSchema = z.array(z.string().trim().min(1).max(40)).max(15).default([]);

const createRoleSchema = z.object({
  domainId: z.string().cuid(),
  title: z.string().trim().superRefine((t, ctx) => {
    const problem = catalogTitleProblem(t);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }),
  familyId: z.string().cuid().optional(),
  techStack: techStackSchema,
}).strict();

const catalogCreateLimit = rateLimit({ name: 'catalog-role-create', windowMs: 15 * 60_000, max: 20, keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown' });

type CatalogRoleRow = Awaited<ReturnType<typeof findActiveRoles>>[number];

function displayBand(id: BandId, label: string, yearsPrior: { readonly min: number; readonly max: number }): string {
  const cleanLabel = label.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*\/.*$/, '').trim();
  const years = Number.isFinite(yearsPrior.max) ? `${yearsPrior.min}–${yearsPrior.max} yrs` : `${yearsPrior.min}+ yrs`;
  return `${cleanLabel} · ${years}`;
}

function rankRole(role: CatalogRoleRow, normalizedQuery: string): { readonly rank: number; readonly matchedAlias: string | null; readonly exact: boolean } {
  const alias = role.aliases.find((a) => a.normalizedAlias === normalizedQuery)
    ?? role.aliases.find((a) => a.normalizedAlias.startsWith(normalizedQuery))
    ?? role.aliases.find((a) => a.normalizedAlias.includes(normalizedQuery));
  const values = [role.normalizedTitle, ...role.aliases.map((a) => a.normalizedAlias)];
  const words = role.normalizedTitle.split(' ');
  const exact = values.includes(normalizedQuery);
  const rank = exact ? 0
    : values.some((v) => v.startsWith(normalizedQuery)) ? 1
      : words.some((w) => w.startsWith(normalizedQuery)) ? 2
        : values.some((v) => v.includes(normalizedQuery)) ? 3
          : 4;
  return { rank, matchedAlias: alias?.alias ?? null, exact };
}

function shapeCatalogRole(role: CatalogRoleRow, matchedAlias: string | null) {
  return {
    id: role.id,
    title: role.title,
    domain: { id: role.domain.id, name: role.domain.name },
    family: role.family?.name ?? null,
    marketSignal: role.marketSignal,
    matchedAlias,
  };
}

const ROLE_INCLUDE = { domain: true, family: true, aliases: { where: { status: 'active' } } } as const;
const CANDIDATES_PER_TIER = 100;

/**
 * Candidates for the typeahead, strongest tier first. Each tier is its own
 * bounded query: one query capped at N rows would let a short query such as
 * "qa" fill the cap with substring hits ("Aqa…") and drop the exact "QA".
 */
async function findActiveRoles(domainId: string | undefined, normalizedQuery: string, scopeDomainIds: readonly string[] = []) {
  const base: Prisma.CatalogRoleWhereInput = {
    status: 'active',
    // An explicit domain wins over the organisation's scope: the caller named
    // one area, and narrowing that further would silently return nothing.
    ...(domainId ? { domainId } : scopeDomainIds.length > 0 ? { domainId: { in: [...scopeDomainIds] } } : {}),
  };
  if (!normalizedQuery) {
    return prisma.catalogRole.findMany({ where: base, include: ROLE_INCLUDE, orderBy: { title: 'asc' }, take: CANDIDATES_PER_TIER });
  }
  const alias = (filter: Prisma.StringFilter) => ({ aliases: { some: { status: 'active', normalizedAlias: filter } } });
  const tiers: Prisma.CatalogRoleWhereInput[] = [
    { OR: [{ normalizedTitle: normalizedQuery }, alias({ equals: normalizedQuery })] },
    { OR: [{ normalizedTitle: { startsWith: normalizedQuery } }, alias({ startsWith: normalizedQuery })] },
    { normalizedTitle: { contains: ` ${normalizedQuery}` } },
    { OR: [{ normalizedTitle: { contains: normalizedQuery } }, alias({ contains: normalizedQuery })] },
  ];
  const results = await Promise.all(tiers.map((tier) => prisma.catalogRole.findMany({
    // Ordered so the rows a full tier keeps are the same on SQLite and Postgres.
    where: { AND: [base, tier] }, include: ROLE_INCLUDE, orderBy: { normalizedTitle: 'asc' }, take: CANDIDATES_PER_TIER,
  })));
  const seen = new Set<string>();
  return results.flat().filter((role) => (seen.has(role.id) ? false : (seen.add(role.id), true)));
}

function duplicateResponse(existing: { readonly id: string; readonly title: string; readonly status: string }) {
  return existing.status === 'active'
    ? { error: 'A matching catalog role already exists.', existing: { id: existing.id, title: existing.title } }
    : { error: 'This title was retired from the catalog. Choose a current role or ask the platform owner to restore it.', retired: true };
}

catalogRouter.get('/domains', asyncHandler(async (req, res) => {
  const { scope } = z.object({ scope: scopeSchema }).strict().parse(req.query);
  const scopeDomainIds = await scopedDomainIds(req.auth!.tenantId);
  const scoped = shouldScopeCatalog(scopeDomainIds, scope);
  const domains = await prisma.catalogDomain.findMany({
    where: { status: 'active', ...(scoped ? { id: { in: scopeDomainIds } } : {}) },
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { roles: { where: { status: 'active' } } } } },
  });
  // Still a bare array: every existing caller reads it that way, and turning
  // it into an envelope to carry one boolean would have been a migration for
  // nothing. Whether the list was narrowed is answered by /catalog/scope.
  res.json(domains.map((d) => ({ id: d.id, slug: d.slug, name: d.name, summary: d.summary, roleCount: d._count.roles })));
}));

/**
 * Whether this organisation's catalog view is narrowed, and to what.
 *
 * Its own endpoint rather than an envelope around /domains, so nothing that
 * already reads that array has to change. A page uses this to say "showing
 * your 4 business areas" and to offer the whole catalog.
 */
catalogRouter.get('/scope', asyncHandler(async (req, res) => {
  const [{ limit, areas }, totalDomains] = await Promise.all([
    getTenantBusinessAreas(req.auth!.tenantId),
    prisma.catalogDomain.count({ where: { status: 'active' } }),
  ]);
  res.json({
    scoped: areas.length > 0,
    areas: areas.map(({ id, slug, name }) => ({ id, slug, name })),
    limit,
    totalDomains,
  });
}));

catalogRouter.get('/regions', asyncHandler(async (_req, res) => {
  const regions = await prisma.catalogRegion.findMany({ where: { status: 'active' }, orderBy: { sortOrder: 'asc' } });
  res.json(regions.map((r) => ({ code: r.code, name: r.name })));
}));

catalogRouter.get('/experience-bands', (_req, res) => {
  res.json(BANDS.map((b) => ({ id: b.id, label: b.label, minYears: b.yearsPrior.min, maxYears: Number.isFinite(b.yearsPrior.max) ? b.yearsPrior.max : null, display: displayBand(b.id, b.label, b.yearsPrior) })));
});

catalogRouter.get('/roles', asyncHandler(async (req, res) => {
  const query = roleQuerySchema.parse(req.query);
  const normalizedQuery = normalizeTitle(query.q);
  const scopeDomainIds = await scopedDomainIds(req.auth!.tenantId);
  const rows = await findActiveRoles(
    query.domainId,
    normalizedQuery,
    shouldScopeCatalog(scopeDomainIds, query.scope) ? scopeDomainIds : [],
  );
  const ranked = rows
    .map((role) => ({ role, score: rankRole(role, normalizedQuery) }))
    .filter((r) => !normalizedQuery || r.score.rank < 4)
    .sort((a, b) => a.score.rank - b.score.rank || a.role.title.length - b.role.title.length || a.role.title.localeCompare(b.role.title))
    .slice(0, query.limit);
  res.json({
    exact: normalizedQuery.length > 0 && rows.some((r) => rankRole(r, normalizedQuery).exact),
    roles: ranked.map((r) => shapeCatalogRole(r.role, r.score.matchedAlias)),
  });
}));

catalogRouter.post('/roles', requireCapability('role:create'), catalogCreateLimit, asyncHandler(async (req, res) => {
  const body = createRoleSchema.parse(req.body);
  await assertNotDemoTenant(req.auth!.tenantId);
  const domain = await prisma.catalogDomain.findFirst({ where: { id: body.domainId, status: 'active' } });
  if (!domain) throw new HttpError(400, 'Unknown catalog domain.');
  if (body.familyId) {
    const family = await prisma.catalogJobFamily.findUnique({ where: { id: body.familyId } });
    if (!family) throw new HttpError(400, 'Unknown job family.');
  }
  const result = await addCatalogRole({ auth: req.auth!, domainId: body.domainId, title: body.title, familyId: body.familyId, techStack: body.techStack });
  if (result.kind === 'existing') return res.status(409).json(duplicateResponse(result.role));
  const created = await prisma.catalogRole.findUniqueOrThrow({ where: { id: result.id }, include: ROLE_INCLUDE });
  res.status(201).json({ role: { ...shapeCatalogRole(created, null), techStack: parseJsonStrict<string[]>(created.techStackJson, { model: 'CatalogRole', id: created.id, field: 'techStackJson' }) } });
}));
