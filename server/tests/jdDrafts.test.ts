
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { generatePendingDrafts, getOrQueueDraft } from '../src/services/jdDrafts.js';

const app = createApp();

async function reset() {
  await wipe();
  await prisma.catalogJdDraft.deleteMany();
  await prisma.catalogRoleAlias.deleteMany();
  await prisma.catalogRole.deleteMany();
  await prisma.catalogDomain.deleteMany();
  await prisma.catalogJobFamily.deleteMany();
  await prisma.catalogRegion.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
}

async function fixture() {
  const tenant = await prisma.tenant.create({ data: { name: 'Tenant A' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email: `${Math.random()}@jd.local`, name: 'JD User', passwordHash: 'x', role: 'admin' } });
  const token = signToken({ userId: user.id, tenantId: tenant.id, role: user.role, email: user.email });
  const domain = await prisma.catalogDomain.create({ data: { slug: 'eng', name: 'Engineering', summary: 'Build software', sortOrder: 1 } });
  const family = await prisma.catalogJobFamily.create({ data: { name: `Software ${Math.random()}`, sortOrder: 1 } });
  const region = await prisma.catalogRegion.create({ data: { code: 'IN', name: 'India', sortOrder: 1 } });
  const role = await prisma.catalogRole.create({ data: { domainId: domain.id, familyId: family.id, title: 'Platform Engineer', normalizedTitle: `platform-engineer-${Math.random()}`, summary: 'Build reliable platforms.', marketSignal: 'Kubernetes', source: 'test' } });
  return { tenant, user, token, domain, region, role };
}

beforeEach(reset);

describe('JD draft routes and service', () => {
  it('queues idempotently under concurrent requests and the job makes it ready', async () => {
    const { role } = await fixture();
    const rows = await Promise.all(Array.from({ length: 5 }, () => getOrQueueDraft({ catalogRoleId: role.id, experienceBand: 'senior', regionCode: 'IN' })));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(await prisma.catalogJdDraft.count()).toBe(1);

    expect(await generatePendingDrafts({ limit: 5 })).toBe(1);
    const ready = await prisma.catalogJdDraft.findFirstOrThrow();
    expect(ready.status).toBe('ready');
    expect(ready.text).toContain('Platform Engineer');
    expect(ready.text).toContain('India');
  });

  it('serves pending then ready drafts with strict validation', async () => {
    const { token, role } = await fixture();
    const pending = await request(app).get(`/api/jd-drafts?catalogRoleId=${role.id}&experienceBand=senior&regionCode=IN`).set('Authorization', `Bearer ${token}`);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('pending');
    expect((await request(app).get(`/api/jd-drafts?catalogRoleId=${role.id}&experienceBand=bad&regionCode=IN`).set('Authorization', `Bearer ${token}`)).status).toBe(400);
    expect((await request(app).get(`/api/jd-drafts?catalogRoleId=${role.id}&experienceBand=senior&regionCode=IN&extra=1`).set('Authorization', `Bearer ${token}`)).status).toBe(400);
    await generatePendingDrafts({ limit: 5 });
    const ready = await request(app).get(`/api/jd-drafts?catalogRoleId=${role.id}&experienceBand=senior&regionCode=IN`).set('Authorization', `Bearer ${token}`);
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ready', generator: 'heuristic' });
  });

  it('description drafts are not cached and roles persist jdDraftId and jdOrigin while rejecting mismatches', async () => {
    const { token, role, domain } = await fixture();
    const described = await request(app).post('/api/jd-drafts/describe').set('Authorization', `Bearer ${token}`).send({ description: 'Own the platform roadmap, collaborate with product and security, and make reliability measurable for internal teams.', experienceBand: 'senior', regionCode: 'IN', domainId: domain.id });
    expect(described.status).toBe(200);
    expect(await prisma.catalogJdDraft.count()).toBe(0);

    const draft = await prisma.catalogJdDraft.create({ data: { catalogRoleId: role.id, experienceBand: 'senior', regionCode: 'IN', status: 'ready', text: 'Platform Engineer\n\nAbout the role text that is long enough.' } });
    const created = await request(app).post('/api/roles').set('Authorization', `Bearer ${token}`).send({ sourceText: draft.text, useLlm: false, catalogRoleId: role.id, experienceBand: 'senior', regionCode: 'IN', jdDraftId: draft.id, jdOrigin: 'draft' });
    expect(created.status).toBe(201);
    const stored = await prisma.role.findUniqueOrThrow({ where: { id: created.body.role.id } });
    expect(stored).toMatchObject({ jdDraftId: draft.id, jdOrigin: 'draft', sourceText: draft.text });

    const other = await prisma.catalogRole.create({ data: { domainId: domain.id, title: 'Data Engineer', normalizedTitle: 'data-engineer', source: 'test' } });
    const bad = await request(app).post('/api/roles').set('Authorization', `Bearer ${token}`).send({ sourceText: draft.text, useLlm: false, catalogRoleId: other.id, experienceBand: 'senior', regionCode: 'IN', jdDraftId: draft.id, jdOrigin: 'draft' });
    expect(bad.status).toBe(400);
  });
});
