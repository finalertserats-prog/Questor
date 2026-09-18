import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { BANDS, type BandId } from '../engines/experienceBands.js';
import { prisma, parseJsonStrict } from '../db.js';
import { asyncHandler, authenticate, HttpError, requireCapability } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { normalizeTitle } from '../domain/catalogText.js';
import { logAudit } from '../services/audit.js';

export const catalogRouter = Router();
catalogRouter.use(authenticate);

const roleQuerySchema = z.object({
  domainId: z.string().cuid().optional(),
  q: z.string().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(25).default(10),
}).strict();

const techStackSchema = z.array(z.string().trim().min(1).max(40)).max(15).default([]);

const createRoleSchema = z.object({
  domainId: z.string().cuid(),
  title: z.string().trim().min(2).max(120)
    .refine((t) => !/[\r\n]/.test(t), 'Title must be a single line.')
    .refine((t) => /\p{L}/u.test(t), 'Title must contain a letter.')
    .refine((t) => !/@|https?:\/\/|www\./i.test(t), 'Title must not contain contact details or links.')
    .refine((t) => !/\d{6,}/.test(t), 'Title must not contain requisition or phone numbers.'),
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
async function findActiveRoles(domainId: string | undefined, normalizedQuery: string) {
  const base: Prisma.CatalogRoleWhereInput = { status: 'active', ...(domainId ? { domainId } : {}) };
  if (!normalizedQuery) {
    return prisma.catalogRole.findMany({ where: base, include: ROLE_INCLUDE, orderBy: { title: 'asc' }, take: CANDIDATES_PER_TIER });
  }
  const alias = (filter: Prisma.StringFilter) => ({ aliases: { some: { status: 'active', normalizedAlias: filter } } });
  const tiers: Prisma.CatalogRoleWhereInput[] = [
    { OR: [{ normalizedTitle: normalizedQuery }, alias({ equals: normalizedQuery })] },
    { OR: [{ normalizedTitle: { startsWith: normalizedQuery } }, { normalizedTitle: { contains: ` ${normalizedQuery}` } }, alias({ startsWith: normalizedQuery })] },
    { OR: [{ normalizedTitle: { contains: normalizedQuery } }, alias({ contains: normalizedQuery })] },
  ];
  const results = await Promise.all(tiers.map((tier) => prisma.catalogRole.findMany({
    where: { AND: [base, tier] }, include: ROLE_INCLUDE, take: CANDIDATES_PER_TIER,
  })));
  const seen = new Set<string>();
  return results.flat().filter((role) => (seen.has(role.id) ? false : (seen.add(role.id), true)));
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { readonly code?: string }).code === 'P2002';
}

function duplicateResponse(existing: { readonly id: string; readonly title: string; readonly status: string }) {
  return existing.status === 'active'
    ? { error: 'A matching catalog role already exists.', existing: { id: existing.id, title: existing.title } }
    : { error: 'This title was retired from the catalog. Choose a current role or ask the platform owner to restore it.', retired: true };
}

catalogRouter.get('/domains', asyncHandler(async (_req, res) => {
  const domains = await prisma.catalogDomain.findMany({
    where: { status: 'active' },
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { roles: { where: { status: 'active' } } } } },
  });
  res.json(domains.map((d) => ({ id: d.id, slug: d.slug, name: d.name, summary: d.summary, roleCount: d._count.roles })));
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
  const rows = await findActiveRoles(query.domainId, normalizedQuery);
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
  const domain = await prisma.catalogDomain.findFirst({ where: { id: body.domainId, status: 'active' } });
  if (!domain) throw new HttpError(400, 'Unknown catalog domain.');
  if (body.familyId) {
    const family = await prisma.catalogJobFamily.findUnique({ where: { id: body.familyId } });
    if (!family) throw new HttpError(400, 'Unknown job family.');
  }
  const normalizedTitle = normalizeTitle(body.title);
  // Retired roles count too: the (domain, title) key is unique whatever the
  // status, and a retired title is the owner's decision, not a free slot.
  const existing = await prisma.catalogRole.findFirst({
    where: {
      domainId: body.domainId,
      OR: [{ normalizedTitle }, { aliases: { some: { normalizedAlias: normalizedTitle } } }],
    },
    select: { id: true, title: true, status: true },
  });
  if (existing) return res.status(409).json(duplicateResponse(existing));
  const auth = req.auth!;
  const created = await prisma.catalogRole.create({
    data: {
      domainId: body.domainId,
      familyId: body.familyId,
      title: body.title,
      normalizedTitle,
      techStackJson: JSON.stringify(body.techStack),
      source: 'org',
      createdByTenantId: auth.tenantId,
      createdById: auth.userId,
    },
    include: { domain: true, family: true, aliases: true },
  }).catch(async (err: unknown) => {
    // Two people adding the same title at once: the loser gets the winner's row.
    if (!isUniqueViolation(err)) throw err;
    const winner = await prisma.catalogRole.findFirst({ where: { domainId: body.domainId, normalizedTitle }, select: { id: true, title: true, status: true } });
    if (!winner) throw err;
    return winner;
  });
  if (!('domain' in created)) return res.status(409).json(duplicateResponse(created));
  await logAudit({ tenantId: auth.tenantId, actorId: auth.userId, actorType: 'user', action: 'catalog.role.created', entityType: 'CatalogRole', entityId: created.id, after: { title: created.title, domainId: created.domainId } });
  res.status(201).json({ role: { ...shapeCatalogRole(created, null), techStack: parseJsonStrict<string[]>(created.techStackJson, { model: 'CatalogRole', id: created.id, field: 'techStackJson' }) } });
}));
