/**
 * The business areas an organisation hires in.
 *
 * Reuses the shared role catalog's own `CatalogDomain` rows — the taxonomy the
 * catalog already groups all 492 seeded roles under, and the one the role form
 * already shows as "Domain". Nothing here invents a second list.
 *
 * What these rows do is narrow a *view*. They are never a data boundary: the
 * catalog is global and shared, `scope=all` returns all of it to anyone signed
 * in, and an organisation with no rows (every organisation that existed before
 * onboarding) sees exactly what it saw before.
 */

import { prisma } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { logAudit } from './audit.js';
import {
  DEFAULT_BUSINESS_AREA_LIMIT, MAX_BUSINESS_AREA_LIMIT, businessAreaSelectionProblem,
} from '../domain/orgOnboarding.js';

export interface BusinessArea {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
}

/** Every business area an organisation may choose from, in catalog order. */
export async function listBusinessAreas(): Promise<BusinessArea[]> {
  const domains = await prisma.catalogDomain.findMany({
    where: { status: 'active' },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, slug: true, name: true, summary: true },
  });
  return domains;
}

/**
 * Catalog domain ids for the slugs given, in the order asked for, or an
 * HttpError naming what was wrong. `limit` is the organisation's own limit.
 */
export async function resolveBusinessAreaSlugs(slugs: readonly string[], limit: number): Promise<string[]> {
  const areas = await listBusinessAreas();
  const bySlug = new Map(areas.map((a) => [a.slug, a.id]));
  const problem = businessAreaSelectionProblem(slugs, new Set(bySlug.keys()), limit);
  if (problem) throw new HttpError(400, problem.message);
  return slugs.map((s) => bySlug.get(s)!);
}

export interface TenantBusinessAreas {
  readonly limit: number;
  /** The chosen areas, in catalog order. Empty means "everything". */
  readonly areas: readonly BusinessArea[];
}

/** What one organisation has chosen, and how many it may hold. */
export async function getTenantBusinessAreas(tenantId: string): Promise<TenantBusinessAreas> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      businessAreaLimit: true,
      businessAreas: {
        select: { domain: { select: { id: true, slug: true, name: true, summary: true, sortOrder: true, status: true } } },
      },
    },
  });
  if (!tenant) throw new HttpError(404, 'Organisation not found.');
  const areas = tenant.businessAreas
    .map((row) => row.domain)
    // A retired domain stops being an area to browse, but is not deleted from
    // under the organisation: it simply drops out of the view.
    .filter((d) => d.status === 'active')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ id, slug, name, summary }) => ({ id, slug, name, summary }));
  return { limit: tenant.businessAreaLimit, areas };
}

/**
 * The catalog domain ids this organisation's default view is narrowed to.
 * Empty means "not narrowed" — which is both "chose nothing" and "chose
 * nothing that is still active".
 */
export async function scopedDomainIds(tenantId: string): Promise<string[]> {
  const rows = await prisma.tenantBusinessArea.findMany({
    where: { tenantId, domain: { status: 'active' } },
    select: { domainId: true },
  });
  return rows.map((r) => r.domainId);
}

/**
 * Replace an organisation's areas with exactly this set.
 *
 * Going over the limit is refused here rather than silently trimmed: an
 * organisation that asked for six and got five would blame the filter for the
 * roles it then could not find. Raising the limit is the owner's, below.
 */
export async function setTenantBusinessAreas(opts: {
  tenantId: string;
  slugs: readonly string[];
  actorId: string;
  actorType?: 'user' | 'system';
}): Promise<TenantBusinessAreas> {
  const before = await getTenantBusinessAreas(opts.tenantId);
  const domainIds = await resolveBusinessAreaSlugs(opts.slugs, before.limit);

  await prisma.$transaction(async (tx) => {
    await tx.tenantBusinessArea.deleteMany({ where: { tenantId: opts.tenantId } });
    if (domainIds.length > 0) {
      await tx.tenantBusinessArea.createMany({
        data: domainIds.map((domainId) => ({ tenantId: opts.tenantId, domainId })),
      });
    }
  });

  const after = await getTenantBusinessAreas(opts.tenantId);
  await logAudit({
    tenantId: opts.tenantId,
    actorId: opts.actorId,
    actorType: opts.actorType ?? 'user',
    action: 'tenant.business_areas.updated',
    entityType: 'Tenant',
    entityId: opts.tenantId,
    before: { areas: before.areas.map((a) => a.slug), limit: before.limit },
    after: { areas: after.areas.map((a) => a.slug), limit: after.limit },
  });
  return after;
}

/**
 * The platform owner raising (or lowering) how many areas an organisation may
 * hold. Lowering below what they already hold is refused rather than dropping
 * areas nobody chose to drop.
 */
export async function setBusinessAreaLimit(opts: {
  tenantId: string;
  limit: number;
  actorId: string;
}): Promise<TenantBusinessAreas> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_BUSINESS_AREA_LIMIT) {
    throw new HttpError(400, `A limit must be a whole number between 1 and ${MAX_BUSINESS_AREA_LIMIT}.`);
  }
  const before = await getTenantBusinessAreas(opts.tenantId);
  if (opts.limit < before.areas.length) {
    throw new HttpError(409, `This organisation already holds ${before.areas.length} business areas. Ask them to drop some first.`);
  }
  await prisma.tenant.update({ where: { id: opts.tenantId }, data: { businessAreaLimit: opts.limit } });
  await logAudit({
    tenantId: opts.tenantId,
    actorId: opts.actorId,
    actorType: 'user',
    action: 'tenant.business_area_limit.changed',
    entityType: 'Tenant',
    entityId: opts.tenantId,
    before: { limit: before.limit },
    after: { limit: opts.limit },
  });
  return { ...before, limit: opts.limit };
}

export { DEFAULT_BUSINESS_AREA_LIMIT, MAX_BUSINESS_AREA_LIMIT };
