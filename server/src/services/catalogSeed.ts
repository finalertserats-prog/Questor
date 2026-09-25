import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { ROLE_CATALOG } from '../seed/catalog/roleCatalog.js';
import { normalizeTitle, slugifyCatalogName } from '../domain/catalogText.js';

// Global comes first (sortOrder 0): a role open in every region. The
// 20260921100100_global_region Postgres migration inserts the same row for
// databases seeded before it existed.
const GLOBAL_REGION = { code: 'GLOBAL', name: 'Global (all regions)', sortOrder: 0 } as const;

const REGIONS = [
  { code: 'NA', name: 'North America' },
  { code: 'LATAM', name: 'Latin America' },
  { code: 'UKI', name: 'UK & Ireland' },
  { code: 'EU', name: 'Europe' },
  { code: 'MENA', name: 'Middle East & North Africa' },
  { code: 'IN', name: 'India' },
  { code: 'APAC', name: 'Asia-Pacific' },
  { code: 'ANZ', name: 'Australia & New Zealand' },
] as const;

const BATCH = 100;

function uniqueSortedFamilies(): readonly string[] {
  return [...new Set(ROLE_CATALOG.domains.flatMap((d) => d.roles.map((r) => r.family)))].sort((a, b) => a.localeCompare(b));
}

function isUniqueRace(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { readonly code?: string }).code === 'P2002';
}

/**
 * Create each row, treating a unique violation as "another instance got there
 * first". createMany({ skipDuplicates }) would be one statement, but SQLite
 * does not support it, and the row counts here are small.
 */
async function insertEach<T>(rows: readonly T[], create: (row: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    for (const row of rows.slice(i, i + BATCH)) {
      try { await create(row); } catch (err) { if (!isUniqueRace(err)) throw err; }
    }
  }
}

/**
 * Insert whatever the seed has that the database does not, by natural key.
 *
 * It compares keys rather than counting rows: organisations add roles to the
 * same table, so once they have, a count would say "seeded" while a newer seed
 * version's roles were still missing. It never updates or deletes, so an
 * owner's edits and retirements survive every restart. Reading the keys is a
 * few hundred small rows, which is cheap enough to do on every boot.
 */
export async function ensureCatalogSeeded(): Promise<void> {
  const [regionRows, familyRows, domainRows] = await Promise.all([
    prisma.catalogRegion.findMany({ select: { code: true } }),
    prisma.catalogJobFamily.findMany({ select: { name: true } }),
    prisma.catalogDomain.findMany({ select: { slug: true } }),
  ]);
  const regionCodes = new Set(regionRows.map((r) => r.code));
  const familyNames = new Set(familyRows.map((f) => f.name));
  const domainSlugs = new Set(domainRows.map((d) => d.slug));

  await insertEach(
    [GLOBAL_REGION, ...REGIONS.map((r, i) => ({ ...r, sortOrder: i + 1 }))].filter((r) => !regionCodes.has(r.code)),
    (data) => prisma.catalogRegion.create({ data }),
  );
  await insertEach(
    uniqueSortedFamilies().map((name, i) => ({ name, sortOrder: i + 1 })).filter((f) => !familyNames.has(f.name)),
    (data) => prisma.catalogJobFamily.create({ data }),
  );
  await insertEach(
    ROLE_CATALOG.domains
      .map((d) => ({ slug: slugifyCatalogName(d.name), name: d.name, summary: d.summary, sortOrder: d.order }))
      .filter((d) => !domainSlugs.has(d.slug)),
    (data) => prisma.catalogDomain.create({ data }),
  );

  const [domains, families, existingRoles] = await Promise.all([
    prisma.catalogDomain.findMany({ select: { id: true, slug: true } }),
    prisma.catalogJobFamily.findMany({ select: { id: true, name: true } }),
    prisma.catalogRole.findMany({ select: { domainId: true, normalizedTitle: true, aliases: { select: { normalizedAlias: true } } } }),
  ]);
  const domainBySlug = new Map(domains.map((d) => [d.slug, d.id]));
  const familyByName = new Map(families.map((f) => [f.name, f.id]));
  // A role renamed by the owner keeps its old name as an alias, so counting
  // aliases here is what stops a restart from re-adding the old title.
  const roleKeys = new Set(existingRoles.flatMap((r) => [
    `${r.domainId}:${r.normalizedTitle}`,
    ...r.aliases.map((a) => `${r.domainId}:${a.normalizedAlias}`),
  ]));

  const seedRoles = ROLE_CATALOG.domains.flatMap((d) => {
    const domainId = domainBySlug.get(slugifyCatalogName(d.name));
    return domainId ? d.roles.map((r) => ({ domainId, role: r, normalizedTitle: normalizeTitle(r.title) })) : [];
  });
  await insertEach(
    seedRoles.filter((r) => !roleKeys.has(`${r.domainId}:${r.normalizedTitle}`)),
    (r) => prisma.catalogRole.create({
      data: {
        domainId: r.domainId,
        familyId: familyByName.get(r.role.family),
        title: r.role.title,
        normalizedTitle: r.normalizedTitle,
        summary: r.role.purpose,
        marketSignal: r.role.marketSignal,
        source: 'seed',
      },
    }),
  );

  const withAliases = seedRoles.filter((r) => r.role.aliases.length > 0);
  if (withAliases.length === 0) return;
  const [roles, existingAliases] = await Promise.all([
    prisma.catalogRole.findMany({
      where: { OR: withAliases.map((r) => ({ domainId: r.domainId, normalizedTitle: r.normalizedTitle })) },
      select: { id: true, domainId: true, normalizedTitle: true },
    }),
    prisma.catalogRoleAlias.findMany({ select: { roleId: true, normalizedAlias: true } }),
  ]);
  const roleByKey = new Map(roles.map((r) => [`${r.domainId}:${r.normalizedTitle}`, r.id]));
  const aliasKeys = new Set(existingAliases.map((a) => `${a.roleId}:${a.normalizedAlias}`));
  const missingAliases = withAliases.flatMap((r) => {
    const roleId = roleByKey.get(`${r.domainId}:${r.normalizedTitle}`);
    return roleId
      ? r.role.aliases
        .map((alias) => ({ roleId, alias, normalizedAlias: normalizeTitle(alias), source: 'seed' }))
        .filter((a) => !aliasKeys.has(`${a.roleId}:${a.normalizedAlias}`))
      : [];
  });
  await insertEach(missingAliases, (data) => prisma.catalogRoleAlias.create({ data }));
}

const DEFAULT_RETRY_DELAY_MS = 60_000;

/**
 * Seed, and keep trying if it fails. A seed that failed once used to leave the
 * New role form with an empty catalog until someone restarted the server.
 * Resolves true once seeded, false if `maxAttempts` ran out.
 */
export async function seedCatalogWithRetry(opts: {
  readonly seeder?: () => Promise<void>;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
} = {}): Promise<boolean> {
  const seeder = opts.seeder ?? ensureCatalogSeeded;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await seeder();
      return true;
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), attempt }, 'Could not seed role catalog');
      if (attempt < maxAttempts) {
        // unref: a pending retry must never be what keeps a stopping process alive.
        await new Promise<void>((resolve) => { setTimeout(resolve, retryDelayMs).unref?.(); });
      }
    }
  }
  return false;
}
