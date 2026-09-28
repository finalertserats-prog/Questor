import { prisma } from '../db.js';
import { normalizeTitle } from '../domain/catalogText.js';
import { buildCatalogIndex, type CatalogIndex, type CatalogRoleForMatch } from '../domain/catalogMatch.js';
import { familiesByDomain, type AllowedClassificationIds } from '../domain/catalogClassification.js';
import type { SpendLimits } from './catalogRefreshRun.js';

/**
 * Everything a run compares candidates against, loaded once per run (and once
 * more on resume) rather than queried per candidate: the catalog, the domains
 * and families, and the titles already pending or recently rejected.
 */

export const REJECTION_MEMORY_MS = 180 * 24 * 60 * 60_000;

export interface RunContext {
  readonly runId: string;
  readonly index: CatalogIndex;
  readonly allowed: AllowedClassificationIds;
  readonly domains: readonly { readonly id: string; readonly name: string }[];
  readonly names: { readonly domains: ReadonlyMap<string, string>; readonly families: ReadonlyMap<string, string> };
  /** Active roles in a stable order, for the ESCO lookups' cursor. */
  readonly rolesById: readonly CatalogRoleForMatch[];
  /** How far this run may spend on model and research calls. */
  readonly limits: SpendLimits;
}

async function loadRoles() {
  return prisma.catalogRole.findMany({
    select: { id: true, title: true, domainId: true, familyId: true, status: true, aliases: { where: { status: 'active' }, select: { alias: true } } },
    orderBy: { id: 'asc' },
  });
}

export async function loadRunContext(runId: string, limits: SpendLimits): Promise<RunContext> {
  const [roles, domains, families] = await Promise.all([
    loadRoles(),
    prisma.catalogDomain.findMany({ where: { status: 'active' }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
    prisma.catalogJobFamily.findMany({ select: { id: true, name: true } }),
  ]);
  const activeDomainIds = new Set(domains.map((d) => d.id));
  const active: CatalogRoleForMatch[] = roles
    .filter((r) => r.status === 'active' && activeDomainIds.has(r.domainId))
    .map((r) => ({ id: r.id, title: r.title, domainId: r.domainId, familyId: r.familyId, aliases: r.aliases.map((a) => a.alias) }));
  const matchIndex = buildCatalogIndex(active);
  // A retired title is still "known": proposing it again would only be
  // superseded at approval, so it never reaches the queue.
  const retired = roles.filter((r) => r.status !== 'active').flatMap((r) => [r.title, ...r.aliases.map((a) => a.alias)]).map(normalizeTitle);
  return {
    runId,
    index: { ...matchIndex, known: new Set([...matchIndex.known, ...retired]) },
    allowed: { domainIds: activeDomainIds, familiesByDomain: familiesByDomain(active) },
    domains,
    names: { domains: new Map(domains.map((d) => [d.id, d.name])), families: new Map(families.map((f) => [f.id, f.name])) },
    rolesById: active,
    limits,
  };
}

/** Titles no new proposal may repeat: pending anywhere, or rejected in the last 180 days. */
export async function loadBlockedTitles(now: Date): Promise<Set<string>> {
  const rows = await prisma.catalogProposal.findMany({
    where: { OR: [{ status: 'pending' }, { status: 'rejected', reviewedAt: { gte: new Date(now.getTime() - REJECTION_MEMORY_MS) } }] },
    select: { normalizedTitle: true },
  });
  return new Set(rows.map((row) => row.normalizedTitle));
}
