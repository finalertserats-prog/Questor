import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { ensureCatalogSeeded } from '../src/services/catalogSeed.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';

/**
 * The Global region: a role open in every region. It is seeded at boot and by
 * a Postgres data migration (for databases that were seeded before it
 * existed), both safe to run any number of times.
 */

const app = createApp();

/**
 * The data migration is a single plain INSERT … ON CONFLICT DO NOTHING, so the
 * same statement runs here against SQLite as runs in production on Postgres.
 */
const MIGRATION = join(process.cwd(), 'prisma', 'postgres', 'migrations', '20260921100100_global_region', 'migration.sql');

async function runMigration() {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
}

async function globalRows() {
  return prisma.catalogRegion.findMany({ where: { code: 'GLOBAL' }, select: { code: true, name: true, sortOrder: true, status: true } });
}

async function adminToken() {
  const tenant = await prisma.tenant.create({ data: { name: 'Global Co' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email: `g${Math.random()}@global.local`, name: 'G', passwordHash: 'x', role: 'admin' } });
  return signToken({ userId: user.id, tenantId: tenant.id, role: user.role, email: user.email });
}

const EXPECTED = [{ code: 'GLOBAL', name: 'Global (all regions)', sortOrder: 0, status: 'active' }];

beforeEach(async () => {
  await wipe();
  await prisma.catalogJdDraft.deleteMany();
  await prisma.catalogRegion.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
});

describe('seeding the Global region', () => {
  it('seeds Global at boot, once, however often the seed runs', async () => {
    await ensureCatalogSeeded();
    await ensureCatalogSeeded();
    expect(await globalRows()).toEqual(EXPECTED);
  });

  it('lists Global first among the regions', async () => {
    await ensureCatalogSeeded();
    const res = await request(app).get('/api/catalog/regions').set('Authorization', `Bearer ${await adminToken()}`);
    expect(res.body[0]).toEqual({ code: 'GLOBAL', name: 'Global (all regions)' });
  });

  it('inserts Global from the data migration, and running it twice changes nothing', async () => {
    await runMigration();
    await runMigration();
    expect(await globalRows()).toEqual(EXPECTED);
  });

  it('leaves a Global row the boot seed already wrote alone', async () => {
    await ensureCatalogSeeded();
    await prisma.catalogRegion.update({ where: { code: 'GLOBAL' }, data: { name: 'Worldwide' } });
    await runMigration();
    expect((await globalRows()).map((r) => r.name)).toEqual(['Worldwide']);
  });

  it('never re-adds Global at boot after the migration wrote it', async () => {
    await runMigration();
    await ensureCatalogSeeded();
    expect(await prisma.catalogRegion.count({ where: { code: 'GLOBAL' } })).toBe(1);
  });
});

describe('creating a Global role', () => {
  it('accepts Global because it is an active catalog region', async () => {
    await ensureCatalogSeeded();
    const res = await request(app).post('/api/roles').set('Authorization', `Bearer ${await adminToken()}`)
      .send({ sourceText: 'Platform engineer JD text', useLlm: false, regionCode: 'GLOBAL' });
    expect({ status: res.status, regionCode: res.body.role?.regionCode }).toEqual({ status: 201, regionCode: 'GLOBAL' });
  });

  it('refuses Global once an owner has retired it', async () => {
    await ensureCatalogSeeded();
    await prisma.catalogRegion.update({ where: { code: 'GLOBAL' }, data: { status: 'retired' } });
    const res = await request(app).post('/api/roles').set('Authorization', `Bearer ${await adminToken()}`)
      .send({ sourceText: 'Platform engineer JD text', useLlm: false, regionCode: 'GLOBAL' });
    expect(res.status).toBe(400);
  });
});
