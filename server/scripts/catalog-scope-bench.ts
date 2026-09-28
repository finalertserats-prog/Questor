/**
 * Does narrowing the catalog to an organisation's business areas actually make
 * its search faster?
 *
 * The claim behind the feature is "the selection of domain will make the roles
 * only visible for that domain visible; this will make the search better and
 * faster". This measures it, through the real endpoint, against a catalog the
 * size a live deployment carries: the full 492-role seed across all 35 domains,
 * plus organisation-created titles on top, which is where a real catalog grows.
 *
 * Two identical organisations run the identical queries. One has chosen four
 * business areas; the other has chosen none, which is what every organisation
 * looked like before onboarding existed.
 *
 *   npx tsx scripts/catalog-scope-bench.ts [--roles 3000] [--runs 40]
 *
 * Writes nothing outside its own throwaway database.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const here = resolve(import.meta.dirname, '..');
mkdirSync(resolve(here, 'prisma/data'), { recursive: true });
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = `file:${resolve(here, 'prisma/data/bench-catalog-scope.db').replace(/\\/g, '/')}`;
process.env.AUTH_SECRET ??= 'catalog-scope-bench-not-a-real-deployment-secret';

const { execFileSync } = await import('node:child_process');
execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--force-reset'], {
  cwd: here, stdio: 'ignore', shell: process.platform === 'win32',
});

const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { signToken } = await import('../src/services/auth.js');
const { ensureCatalogSeeded } = await import('../src/services/catalogSeed.js');
const { normalizeTitle } = await import('../src/domain/catalogText.js');

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const TARGET_ROLES = arg('roles', 3000);
const RUNS = arg('runs', 40);

/** Queries a recruiter actually types: short prefixes, whole words, an alias. */
const QUERIES = ['eng', 'data', 'manager', 'analyst', 'lead', 'sec', 'product', 'quality', 'cloud', 'finance'];

const app = createApp();

async function main() {
  await ensureCatalogSeeded();
  const domains = await prisma.catalogDomain.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } });

  // Grow the catalog the way a live one grows: organisations add their own
  // titles, spread across every domain, on top of the seed.
  const seeded = await prisma.catalogRole.count();
  const extra = Math.max(0, TARGET_ROLES - seeded);
  if (extra > 0) {
    const rows = Array.from({ length: extra }, (_, i) => {
      const title = `${['Senior', 'Staff', 'Principal', 'Lead', 'Associate'][i % 5]} ${['Engineer', 'Analyst', 'Manager', 'Specialist', 'Consultant'][i % 5]} ${i}`;
      return {
        domainId: domains[i % domains.length].id,
        title, normalizedTitle: normalizeTitle(title), source: 'org', status: 'active',
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      await prisma.catalogRole.createMany({ data: rows.slice(i, i + 500) });
    }
  }
  const total = await prisma.catalogRole.count();

  const scopedAreas = domains.slice(0, 4);
  const [wide, narrow] = await Promise.all([
    makeTenant('Wide Org', 'bench-wide', []),
    makeTenant('Narrow Org', 'bench-narrow', scopedAreas.map((d) => d.id)),
  ]);

  const narrowRoleCount = await prisma.catalogRole.count({
    where: { status: 'active', domainId: { in: scopedAreas.map((d) => d.id) } },
  });

  // One untimed pass each so neither side pays for a cold cache.
  await sweep(wide, 1);
  await sweep(narrow, 1);

  const wideMs = await sweep(wide, RUNS);
  const narrowMs = await sweep(narrow, RUNS);

  const wideHits = await hits(wide);
  const narrowHits = await hits(narrow);

  const perQuery = QUERIES.length * RUNS;
  console.log('');
  console.log(`Catalog: ${total} active roles across ${domains.length} domains`);
  console.log(`Scoped organisation holds ${scopedAreas.length} business areas (${narrowRoleCount} roles, ${pct(narrowRoleCount / total)} of the catalog)`);
  console.log(`${QUERIES.length} queries x ${RUNS} runs = ${perQuery} searches per side`);
  console.log('');
  console.log(`  before (no areas chosen) : ${fmt(wideMs)} ms total, ${fmt(wideMs / perQuery)} ms per search, ${wideHits} results returned`);
  console.log(`  after  (4 areas chosen)  : ${fmt(narrowMs)} ms total, ${fmt(narrowMs / perQuery)} ms per search, ${narrowHits} results returned`);
  console.log('');
  console.log(`  search time  : ${pct(1 - narrowMs / wideMs)} faster`);
  console.log(`  results to read through: ${pct(1 - narrowHits / Math.max(1, wideHits))} fewer`);
  await prisma.$disconnect();
}

async function makeTenant(name: string, slug: string, domainIds: readonly string[]) {
  const tenant = await prisma.tenant.create({ data: { name, slug } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email: `${slug}@bench.test`, name, passwordHash: 'x', role: 'admin' },
  });
  if (domainIds.length > 0) {
    await prisma.tenantBusinessArea.createMany({ data: domainIds.map((domainId) => ({ tenantId: tenant.id, domainId })) });
  }
  return `Bearer ${signToken({ userId: user.id, tenantId: tenant.id, role: 'admin', email: user.email })}`;
}

async function sweep(auth: string, runs: number): Promise<number> {
  const started = performance.now();
  for (let run = 0; run < runs; run += 1) {
    for (const q of QUERIES) {
      await request(app).get(`/api/catalog/roles?q=${q}&limit=25`).set('Authorization', auth);
    }
  }
  return performance.now() - started;
}

async function hits(auth: string): Promise<number> {
  let n = 0;
  for (const q of QUERIES) {
    const res = await request(app).get(`/api/catalog/roles?q=${q}&limit=25`).set('Authorization', auth);
    n += (res.body.roles ?? []).length;
  }
  return n;
}

const fmt = (n: number) => n.toFixed(n < 10 ? 2 : 0);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

await main();
