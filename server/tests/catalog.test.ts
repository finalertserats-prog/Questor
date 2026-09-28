import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { ensureCatalogSeeded } from '../src/services/catalogSeed.js';
import { normalizeTitle, slugifyCatalogName } from '../src/domain/catalogText.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';

const app = createApp();

async function resetCatalog() {
  await wipe();
  await prisma.catalogRoleAlias.deleteMany();
  await prisma.catalogRole.deleteMany();
  await prisma.catalogDomain.deleteMany();
  await prisma.catalogJobFamily.deleteMany();
  await prisma.catalogRegion.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
}

async function makeUser(tenantId: string, email: string, role = 'admin') {
  const user = await prisma.user.create({ data: { tenantId, email, name: email, passwordHash: 'x', role } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

async function makeTenantUser(email: string, role = 'admin') {
  const tenant = await prisma.tenant.create({ data: { name: email.split('@')[0] } });
  const user = await makeUser(tenant.id, email, role);
  return { tenant, user };
}

async function counts() {
  const [domains, roles, regions, families, aliases] = await Promise.all([
    prisma.catalogDomain.count(),
    prisma.catalogRole.count(),
    prisma.catalogRegion.count(),
    prisma.catalogJobFamily.count(),
    prisma.catalogRoleAlias.count(),
  ]);
  return { domains, roles, regions, families, aliases };
}

async function domain(name: string) {
  return prisma.catalogDomain.findUniqueOrThrow({ where: { slug: slugifyCatalogName(name) } });
}

async function createCatalogRole(domainId: string, title: string, extras: Partial<{ status: string; source: string }> = {}) {
  return prisma.catalogRole.create({
    data: {
      domainId,
      title,
      normalizedTitle: normalizeTitle(title),
      source: extras.source ?? 'test',
      status: extras.status ?? 'active',
    },
  });
}

beforeEach(async () => {
  await resetCatalog();
});

describe('catalog seed', () => {
  it('is idempotent, preserves local edits and has the expected fixture counts', async () => {
    await ensureCatalogSeeded();
    expect(await counts()).toEqual({ domains: 35, roles: 492, regions: 9, families: 9, aliases: 2 });

    const role = await prisma.catalogRole.findFirstOrThrow({ where: { status: 'active' }, orderBy: { title: 'asc' } });
    await prisma.catalogRole.update({ where: { id: role.id }, data: { title: 'Locally Edited Title', status: 'retired' } });

    await ensureCatalogSeeded();
    expect(await counts()).toEqual({ domains: 35, roles: 492, regions: 9, families: 9, aliases: 2 });
    expect(await prisma.catalogRole.findUniqueOrThrow({ where: { id: role.id } })).toMatchObject({ title: 'Locally Edited Title', status: 'retired' });
  });
});

describe('GET /api/catalog/roles', () => {
  it('ranks exact before prefix before word-prefix before substring and reports alias matches', async () => {
    const { tenant, user } = await makeTenantUser('rank@catalog.local');
    const d = await prisma.catalogDomain.create({ data: { slug: 'engineering', name: 'Engineering', sortOrder: 1 } });
    await createCatalogRole(d.id, 'Platform Alpha Engineer'); // word-prefix for alpha
    await createCatalogRole(d.id, 'Zalpha Engineer'); // substring
    await createCatalogRole(d.id, 'Alpha Beta Engineer'); // prefix
    await createCatalogRole(d.id, 'Alpha'); // exact
    const fde = await createCatalogRole(d.id, 'Forward Deployed Engineer');
    await prisma.catalogRoleAlias.create({ data: { roleId: fde.id, alias: 'FDE', normalizedAlias: 'fde', source: 'test' } });

    const ranked = await request(app).get('/api/catalog/roles?q=alpha&limit=10').set('Authorization', `Bearer ${user.token}`);
    expect(ranked.status).toBe(200);
    expect(ranked.body.exact).toBe(true);
    expect(ranked.body.roles.map((r: { title: string }) => r.title)).toEqual([
      'Alpha',
      'Alpha Beta Engineer',
      'Platform Alpha Engineer',
      'Zalpha Engineer',
    ]);

    const alias = await request(app).get('/api/catalog/roles?q=FDE').set('Authorization', `Bearer ${user.token}`);
    expect(alias.status).toBe(200);
    expect(alias.body).toMatchObject({ exact: true, roles: [{ title: 'Forward Deployed Engineer', matchedAlias: 'FDE' }] });
    expect(tenant.id).toBeTruthy();
  });

  it('restricts by domain and validates query shape strictly', async () => {
    await ensureCatalogSeeded();
    const { user } = await makeTenantUser('query@catalog.local');
    const ai = await domain('Frontier AI, Applied AI & Forward Deployed Engineering');
    const other = await domain('Cybersecurity, Privacy, Trust & Safety');

    const restricted = await request(app).get(`/api/catalog/roles?q=engineer&domainId=${ai.id}`).set('Authorization', `Bearer ${user.token}`);
    expect(restricted.status).toBe(200);
    expect(restricted.body.roles.length).toBeGreaterThan(0);
    expect(restricted.body.roles.every((r: { domain: { id: string } }) => r.domain.id === ai.id)).toBe(true);
    expect(restricted.body.roles.some((r: { domain: { id: string } }) => r.domain.id === other.id)).toBe(false);

    expect((await request(app).get('/api/catalog/roles?q=engineer&tenantId=leak').set('Authorization', `Bearer ${user.token}`)).status).toBe(400);
    expect((await request(app).get(`/api/catalog/roles?q=${'a'.repeat(101)}`).set('Authorization', `Bearer ${user.token}`)).status).toBe(400);
    expect((await request(app).get('/api/catalog/roles?q=definitely-not-here').set('Authorization', `Bearer ${user.token}`)).body.exact).toBe(false);
  });
});

describe('POST /api/catalog/roles', () => {
  it('creates a shared role visible to another tenant and never returns creator tenant data', async () => {
    await ensureCatalogSeeded();
    const d = await domain('Cybersecurity, Privacy, Trust & Safety');
    const a = await makeTenantUser('a@catalog.local');
    const b = await makeTenantUser('b@catalog.local');

    const created = await request(app).post('/api/catalog/roles').set('Authorization', `Bearer ${a.user.token}`).send({ domainId: d.id, title: 'Quantum Risk Wrangler', techStack: ['Rust'] });
    expect(created.status).toBe(201);
    expect(created.body.role).toMatchObject({ title: 'Quantum Risk Wrangler', techStack: ['Rust'] });
    expect(JSON.stringify(created.body)).not.toContain('createdByTenantId');

    const found = await request(app).get('/api/catalog/roles?q=quantum risk').set('Authorization', `Bearer ${b.user.token}`);
    expect(found.status).toBe(200);
    expect(found.body.roles).toEqual([expect.objectContaining({ title: 'Quantum Risk Wrangler' })]);
  });

  it('rejects duplicates in the same domain but allows the same title in another domain', async () => {
    await ensureCatalogSeeded();
    const { user } = await makeTenantUser('dupe@catalog.local');
    const d1 = await domain('Frontier AI, Applied AI & Forward Deployed Engineering');
    const d2 = await domain('Cybersecurity, Privacy, Trust & Safety');
    const role = await createCatalogRole(d1.id, 'Collision Role');
    await prisma.catalogRoleAlias.create({ data: { roleId: role.id, alias: 'Alias Collision', normalizedAlias: normalizeTitle('Alias Collision'), source: 'test' } });

    expect((await request(app).post('/api/catalog/roles').set('Authorization', `Bearer ${user.token}`).send({ domainId: d1.id, title: 'Collision Role' })).status).toBe(409);
    expect((await request(app).post('/api/catalog/roles').set('Authorization', `Bearer ${user.token}`).send({ domainId: d1.id, title: 'Alias Collision' })).status).toBe(409);
    expect((await request(app).post('/api/catalog/roles').set('Authorization', `Bearer ${user.token}`).send({ domainId: d2.id, title: 'Collision Role' })).status).toBe(201);
  });

  it('validates titles, permissions and rate limiting', async () => {
    await ensureCatalogSeeded();
    const d = await domain('Product Management, Design & Digital Experience');
    const admin = await makeTenantUser('admin@catalog.local');
    const auditor = await makeTenantUser('auditor@catalog.local', 'auditor');
    const reviewer = await makeTenantUser('reviewer@catalog.local', 'reviewer');

    for (const title of ['boss@example.com', 'Visit https://example.com/jobs', 'Engineer 123456']) {
      const res = await request(app).post('/api/catalog/roles').set('Authorization', `Bearer ${admin.user.token}`).send({ domainId: d.id, title });
      expect(res.status).toBe(400);
    }
    expect((await request(app).post('/api/catalog/roles').set('Authorization', `Bearer ${auditor.user.token}`).send({ domainId: d.id, title: 'Auditor Role' })).status).toBe(403);
    expect((await request(app).post('/api/catalog/roles').set('Authorization', `Bearer ${reviewer.user.token}`).send({ domainId: d.id, title: 'Reviewer Role' })).status).toBe(403);

    // The app disables route rate limits under NODE_ENV=test; pin the catalog limiter through its shared primitive.
    const { consume } = await import('../src/middleware/rateLimit.js');
    for (let i = 0; i < 20; i += 1) expect((await consume('catalog-role-create', admin.user.id, 60_000, 20)).allowed).toBe(true);
    expect(await consume('catalog-role-create', admin.user.id, 60_000, 20)).toMatchObject({ allowed: false, reason: 'limit' });
  });
});

describe('POST /api/roles with catalog fields', () => {
  it('persists catalog role, experience band, region and tech stack, and rejects inactive catalog roles or bad regions', async () => {
    await ensureCatalogSeeded();
    const { tenant, user } = await makeTenantUser('roles@catalog.local');
    const catalogRole = await prisma.catalogRole.findFirstOrThrow({ where: { status: 'active' } });
    const inactive = await createCatalogRole(catalogRole.domainId, 'Inactive Catalog Role', { status: 'retired' });

    const created = await request(app).post('/api/roles').set('Authorization', `Bearer ${user.token}`).send({
      sourceType: 'paste', sourceText: 'We need a person to build reliable services and collaborate with product teams.', useLlm: false,
      catalogRoleId: catalogRole.id, experienceBand: 'senior', regionCode: 'IN', techStack: ['TypeScript', 'Postgres'],
    });
    expect(created.status).toBe(201);
    // Bare names still arrive from older pages; they are stored as full items.
    const stack = [{ name: 'TypeScript', category: 'language', level: 'working', required: true }, { name: 'Postgres', category: 'data', level: 'working', required: true }];
    expect(created.body.role).toMatchObject({ catalogRole: { id: catalogRole.id }, experienceBand: 'senior', regionCode: 'IN', techStack: stack });
    const row = await prisma.role.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(row).toMatchObject({ catalogRoleId: catalogRole.id, experienceBand: 'senior', regionCode: 'IN', techStackJson: JSON.stringify(stack) });

    expect((await request(app).post('/api/roles').set('Authorization', `Bearer ${user.token}`).send({ sourceText: 'JD text', useLlm: false, catalogRoleId: inactive.id, experienceBand: 'senior', regionCode: 'IN' })).status).toBe(400);
    expect((await request(app).post('/api/roles').set('Authorization', `Bearer ${user.token}`).send({ sourceText: 'JD text', useLlm: false, catalogRoleId: catalogRole.id, experienceBand: 'senior', regionCode: 'NOPE' })).status).toBe(400);
  });

  it("does not expose one tenant's roles through catalog endpoints", async () => {
    await ensureCatalogSeeded();
    const a = await makeTenantUser('tenant-a@catalog.local');
    const b = await makeTenantUser('tenant-b@catalog.local');
    const catalogRole = await prisma.catalogRole.findFirstOrThrow({ where: { status: 'active' } });
    await prisma.role.create({ data: { tenantId: a.tenant.id, title: 'Tenant A Secret Requisition', status: 'approved', catalogRoleId: catalogRole.id } });

    const catalog = await request(app).get('/api/catalog/roles?q=secret').set('Authorization', `Bearer ${b.user.token}`);
    expect(catalog.status).toBe(200);
    expect(JSON.stringify(catalog.body)).not.toContain('Tenant A Secret Requisition');
    expect(JSON.stringify(catalog.body)).not.toContain(a.tenant.id);
  });
});


describe('catalog review fixes', () => {
  it('adds a role new to the seed even when organisation roles already push the count past the seed size', async () => {
    await ensureCatalogSeeded();
    // Stands in for a role that a later seed version adds.
    const newInNextVersion = await prisma.catalogRole.findFirstOrThrow({ where: { source: 'seed', aliases: { none: {} } } });
    await prisma.catalogRole.delete({ where: { id: newInNextVersion.id } });
    for (let i = 0; i < 10; i += 1) await createCatalogRole(newInNextVersion.domainId, `Org Role ${i}`, { source: 'org' });

    await ensureCatalogSeeded();

    expect(await prisma.catalogRole.count({ where: { source: 'seed' } })).toBe(492);
  });

  it('finds the exact match for a short query even when more than a hundred titles contain it', async () => {
    const { user } = await makeTenantUser('short@catalog.local');
    const d = await prisma.catalogDomain.create({ data: { slug: 'many', name: 'Many', sortOrder: 1 } });
    for (let i = 0; i < 150; i += 1) await createCatalogRole(d.id, `Aqa Specialist ${i}`);
    await createCatalogRole(d.id, 'QA');

    const res = await request(app).get('/api/catalog/roles?q=qa&limit=5').set('Authorization', `Bearer ${user.token}`);

    expect(res.body.roles[0]?.title).toBe('QA');
  });

  it('answers 409, not a server error, when the title matches a retired role in the domain', async () => {
    const { user } = await makeTenantUser('retired@catalog.local');
    const d = await prisma.catalogDomain.create({ data: { slug: 'retired', name: 'Retired', sortOrder: 1 } });
    await createCatalogRole(d.id, 'Legacy Analyst', { status: 'retired' });

    const res = await request(app).post('/api/catalog/roles').set('Authorization', `Bearer ${user.token}`).send({ domainId: d.id, title: 'Legacy Analyst' });

    expect(res.status).toBe(409);
  });

  it('labels experience bands with a real dash and middle dot', async () => {
    const { user } = await makeTenantUser('bands@catalog.local');

    const res = await request(app).get('/api/catalog/experience-bands').set('Authorization', `Bearer ${user.token}`);

    expect(res.body[1].display).toMatch(/^\S.* · \d+–\d+ yrs$/);
  });
});

describe('catalog review fixes, round 2', () => {
  const JD = 'Senior Platform Engineer\nWe need a platform engineer to run our Kubernetes estate. 5+ years with Terraform and Go.';

  async function postRole(token: string, body: Record<string, unknown>) {
    return request(app).post('/api/roles').set('Authorization', `Bearer ${token}`).send({ sourceType: 'paste', sourceText: JD, useLlm: false, experienceBand: 'senior', ...body });
  }

  it('adds a typed title to the shared catalog and links the role when the person chooses to add it', async () => {
    const { user } = await makeTenantUser('typed@catalog.local');
    const d = await prisma.catalogDomain.create({ data: { slug: 'cloud', name: 'Cloud', sortOrder: 1 } });

    const res = await postRole(user.token, { domainId: d.id, title: 'Estate Reliability Engineer', addToCatalog: true });

    const linked = await prisma.role.findUniqueOrThrow({ where: { id: res.body.role.id }, include: { catalogRole: true } });
    expect(linked.catalogRole?.title).toBe('Estate Reliability Engineer');
  });

  it('links to the existing catalog role rather than adding a duplicate', async () => {
    const { user } = await makeTenantUser('dupe@catalog.local');
    const d = await prisma.catalogDomain.create({ data: { slug: 'cloud2', name: 'Cloud Two', sortOrder: 1 } });
    const existing = await createCatalogRole(d.id, 'Estate Reliability Engineer');

    const res = await postRole(user.token, { domainId: d.id, title: 'estate reliability engineer' });

    expect(res.body.role.catalogRole?.id).toBe(existing.id);
  });

  it('still infers the title from the JD when it is left blank, and never publishes what it inferred', async () => {
    const { user } = await makeTenantUser('inferred@catalog.local');
    const d = await prisma.catalogDomain.create({ data: { slug: 'cloud3', name: 'Cloud Three', sortOrder: 1 } });

    const res = await postRole(user.token, { domainId: d.id, addToCatalog: true });

    expect({ status: res.status, catalogRoles: await prisma.catalogRole.count({ where: { domainId: d.id } }) }).toEqual({ status: 201, catalogRoles: 0 });
  });

  it('links an inferred title to an existing catalog entry that matches it', async () => {
    const { user } = await makeTenantUser('inferred-match@catalog.local');
    const d = await prisma.catalogDomain.create({ data: { slug: 'cloud5', name: 'Cloud Five', sortOrder: 1 } });
    const inferred = (await postRole(user.token, {})).body.role.title as string;
    const existing = await createCatalogRole(d.id, inferred);

    const res = await postRole(user.token, { domainId: d.id });

    expect(res.body.role.catalogRole?.id).toBe(existing.id);
  });

  it('treats a whitespace-only title as blank and infers the title from the JD', async () => {
    const { user } = await makeTenantUser('spaces@catalog.local');
    const d = await prisma.catalogDomain.create({ data: { slug: 'cloud4', name: 'Cloud Four', sortOrder: 1 } });

    const res = await postRole(user.token, { domainId: d.id, title: '   ' });

    expect(res.body.role.title.trim()).not.toBe('');
  });

  it('refuses an unknown domain before any extraction is spent', async () => {
    const { user } = await makeTenantUser('baddomain@catalog.local');

    const res = await postRole(user.token, { domainId: 'ckunknowndomain0000000000', title: 'Anything Engineer' });

    expect(res.status).toBe(400);
  });

  it('keeps full-prefix matches when more than a hundred titles only match at a later word', async () => {
    const { user } = await makeTenantUser('prefix@catalog.local');
    const d = await prisma.catalogDomain.create({ data: { slug: 'data', name: 'Data', sortOrder: 1 } });
    for (let i = 0; i < 120; i += 1) await createCatalogRole(d.id, `Senior Data Role ${i}`);
    await createCatalogRole(d.id, 'Database Administrator');

    const res = await request(app).get('/api/catalog/roles?q=data&limit=5').set('Authorization', `Bearer ${user.token}`);

    expect(res.body.roles[0]?.title).toBe('Database Administrator');
  });
});

describe('seedCatalogWithRetry', () => {
  it('tries again after a failed seed instead of giving up until the next restart', async () => {
    const { seedCatalogWithRetry } = await import('../src/services/catalogSeed.js');
    let calls = 0;
    const seeder = async () => { calls += 1; if (calls === 1) throw new Error('db busy'); };

    await seedCatalogWithRetry({ seeder, retryDelayMs: 1, maxAttempts: 3 });

    expect(calls).toBe(2);
  });
});
