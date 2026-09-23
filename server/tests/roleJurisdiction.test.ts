import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { DEMO_JD, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { ensureCatalogSeeded } from '../src/services/catalogSeed.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';
import { extractRoleHeuristic } from '../src/engines/roleIntelligence.js';

/**
 * A role's jurisdiction follows its region. It was 'IN' on every role, which
 * told anything reading the profile that a role in Europe or North America was
 * under Indian rules. A Global role is under no single jurisdiction.
 */

const app = createApp();

async function adminToken() {
  const tenant = await prisma.tenant.create({ data: { name: 'Juris Co' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email: `j${tenant.id}@juris.local`, name: 'J', passwordHash: 'x', role: 'admin' } });
  return signToken({ userId: user.id, tenantId: tenant.id, role: user.role, email: user.email });
}

async function createRole(body: Record<string, unknown>) {
  const token = await adminToken();
  return request(app).post('/api/roles').set({ Authorization: `Bearer ${token}` })
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Platform Engineer', useLlm: false, ...body });
}

async function profileOfNewRole(body: Record<string, unknown>) {
  const res = await createRole(body);
  const scorecard = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId: res.body.role.id } });
  return JSON.parse(scorecard.profileJson).policyRules as { jurisdiction: string; requiredDisclosures: string[] };
}

async function jurisdictionOfNewRole(regionCode?: string): Promise<unknown> {
  return (await profileOfNewRole(regionCode ? { regionCode } : {})).jurisdiction;
}

beforeEach(async () => {
  await wipe();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
  await ensureCatalogSeeded();
});

describe('extractRoleHeuristic', () => {
  it('takes the jurisdiction from the region', () => {
    expect(extractRoleHeuristic(DEMO_JD, 'Platform Engineer', { regionCode: 'EU' }).profile.policyRules.jurisdiction).toBe('EU');
  });

  it('marks a Global role as under no single jurisdiction', () => {
    expect(extractRoleHeuristic(DEMO_JD, 'Platform Engineer', { regionCode: 'GLOBAL' }).profile.policyRules.jurisdiction).toBe('GLOBAL');
  });

  it('leaves the jurisdiction blank when the role has no region', () => {
    expect(extractRoleHeuristic(DEMO_JD, 'Platform Engineer').profile.policyRules.jurisdiction).toBe('');
  });
});

describe('POST /api/roles', () => {
  it('stores a North America role under NA, not IN', async () => {
    expect(await jurisdictionOfNewRole('NA')).toBe('NA');
  });

  it('stores a Global role as GLOBAL', async () => {
    expect(await jurisdictionOfNewRole('GLOBAL')).toBe('GLOBAL');
  });
});

describe('the data migration for existing roles', () => {
  const MIGRATION = join(process.cwd(), 'prisma', 'postgres', 'migrations', '20260922120000_role_jurisdiction_follows_region', 'migration.sql');

  async function runMigration() {
    const sql = readFileSync(MIGRATION, 'utf8').split(/\r?\n/).filter((line) => !line.trim().startsWith('--')).join('\n');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement);
  }

  async function oldRole(regionCode: string | null): Promise<string> {
    const tenant = await prisma.tenant.create({ data: { name: 'Old Co' } });
    const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Old role', regionCode } });
    const profile = { roleContext: 'x', policyRules: { prohibitedTopics: [], jurisdiction: 'IN' } };
    await prisma.roleScorecardVersion.create({ data: { roleId: role.id, version: 1, status: 'approved', profileJson: JSON.stringify(profile) } });
    return role.id;
  }

  async function jurisdictionOf(roleId: string): Promise<unknown> {
    const scorecard = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId } });
    return JSON.parse(scorecard.profileJson).policyRules.jurisdiction;
  }

  it('moves a role in Europe from IN to EU', async () => {
    const roleId = await oldRole('EU');
    await runMigration();
    expect(await jurisdictionOf(roleId)).toBe('EU');
  });

  it('blanks a role that has no region', async () => {
    const roleId = await oldRole(null);
    await runMigration();
    expect(await jurisdictionOf(roleId)).toBe('');
  });

  it('keeps a role in India as IN', async () => {
    const roleId = await oldRole('IN');
    await runMigration();
    expect(await jurisdictionOf(roleId)).toBe('IN');
  });

  it('changes nothing when run a second time', async () => {
    const roleId = await oldRole('NA');
    await runMigration();
    await runMigration();
    expect(await jurisdictionOf(roleId)).toBe('NA');
  });
});

/**
 * A finer place inside the region. Illinois, New York City, Maryland and
 * Colorado each have their own rules about telling a candidate an AI is
 * involved in hiring them, and all four used to be simply "NA". The value is
 * optional: a role without one behaves exactly as every role did before.
 */
describe('a role in a named US state or city', () => {
  it('is stored under the finer jurisdiction, not the region', async () => {
    expect((await profileOfNewRole({ regionCode: 'NA', jurisdictionCode: 'US-IL' })).jurisdiction).toBe('US-IL');
  });

  it('keeps the role under its region when no state is named', async () => {
    expect((await profileOfNewRole({ regionCode: 'NA' })).jurisdiction).toBe('NA');
  });

  it("carries New York City's notices into the role's required disclosures", async () => {
    const policy = await profileOfNewRole({ regionCode: 'NA', jurisdictionCode: 'US-NY-NYC' });
    expect(policy.requiredDisclosures.join(' ')).toMatch(/ten business days/);
  });

  it('carries no extra disclosures for a role that names no state', async () => {
    expect((await profileOfNewRole({ regionCode: 'NA' })).requiredDisclosures)
      .toEqual(['AI interviewer', 'recording/transcription (if enabled)', 'human review of results']);
  });

  it('keeps the three every role has always carried', async () => {
    expect((await profileOfNewRole({ regionCode: 'NA', jurisdictionCode: 'US-CO' })).requiredDisclosures.slice(0, 3))
      .toEqual(['AI interviewer', 'recording/transcription (if enabled)', 'human review of results']);
  });

  it('records the choice against the role, so it can be read back', async () => {
    const res = await createRole({ regionCode: 'NA', jurisdictionCode: 'US-MD' });
    expect((await prisma.role.findUniqueOrThrow({ where: { id: res.body.role.id } })).jurisdictionCode).toBe('US-MD');
  });

  it('refuses a state that does not belong to the chosen region', async () => {
    const res = await createRole({ regionCode: 'EU', jurisdictionCode: 'US-IL' });
    expect(res.status).toBe(400);
  });

  it('refuses a place Questor does not offer', async () => {
    const res = await createRole({ regionCode: 'NA', jurisdictionCode: 'US-ZZ' });
    expect(res.status).toBe(400);
  });

  it('creates no role at all when the state is refused', async () => {
    await createRole({ regionCode: 'EU', jurisdictionCode: 'US-IL' });
    expect(await prisma.role.count()).toBe(0);
  });

  it('leaves a role created without the field null, as every existing role is', async () => {
    const res = await createRole({ regionCode: 'NA' });
    expect((await prisma.role.findUniqueOrThrow({ where: { id: res.body.role.id } })).jurisdictionCode).toBeNull();
  });

  it('offers the places a customer may choose from', async () => {
    const token = await adminToken();
    const res = await request(app).get('/api/catalog/jurisdictions').set({ Authorization: `Bearer ${token}` });
    expect((res.body as Array<{ code: string }>).map((j) => j.code)).toContain('US-NY-NYC');
  });

  it('says which region each place belongs to, so the form can filter them', async () => {
    const token = await adminToken();
    const res = await request(app).get('/api/catalog/jurisdictions').set({ Authorization: `Bearer ${token}` });
    expect((res.body as Array<{ regionCode: string }>).every((j) => j.regionCode === 'NA')).toBe(true);
  });
});
