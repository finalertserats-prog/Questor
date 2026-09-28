import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { normalizeTitle } from '../src/domain/catalogText.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';
import { installFakeAts } from './fakeAts.js';

/**
 * H2: a title reaches the shared catalog only when a person deliberately adds
 * it. Creating a role with a domain links to an existing entry; publishing a
 * new one needs `addToCatalog: true` AND a title the person typed — never one
 * inferred from a JD, never one copied from an ATS requisition.
 */

const app = createApp();
const JD = 'Senior Platform Engineer\nWe need a platform engineer to run our Kubernetes estate. 5+ years with Terraform and Go.';
const ATS_KEY = 'ats-key-MARKER';

let auth: string;
let domainId: string;

beforeEach(async () => {
  await wipe();
  await prisma.catalogRoleAlias.deleteMany();
  await prisma.catalogRole.deleteMany();
  await prisma.catalogDomain.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
  config.ats.baseUrl = '';
  config.ats.tenantId = '';
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  auth = `Bearer ${login.body.token as string}`;
  domainId = (await prisma.catalogDomain.create({ data: { slug: 'cloud', name: 'Cloud', sortOrder: 1 } })).id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const postRole = (body: Record<string, unknown>) =>
  request(app).post('/api/roles').set('Authorization', auth).send({ sourceType: 'paste', sourceText: JD, useLlm: false, domainId, ...body });

describe('POST /api/roles catalog linking', () => {
  it('does not publish a title inferred from the JD, even with addToCatalog', async () => {
    const res = await postRole({ addToCatalog: true });

    expect({ status: res.status, catalogRoles: await prisma.catalogRole.count() }).toEqual({ status: 201, catalogRoles: 0 });
  });

  it('leaves a role with an inferred title unlinked', async () => {
    const res = await postRole({ addToCatalog: true });

    expect(res.body.role.catalogRole).toBeNull();
  });

  it('does not publish a typed title unless the person asked to add it', async () => {
    await postRole({ title: 'Estate Reliability Engineer' });

    expect(await prisma.catalogRole.count()).toBe(0);
  });

  it('publishes a typed title when the person explicitly adds it, and links the role', async () => {
    const res = await postRole({ title: 'Estate Reliability Engineer', addToCatalog: true });

    const linked = await prisma.role.findUniqueOrThrow({ where: { id: res.body.role.id }, include: { catalogRole: true } });
    expect(linked.catalogRole?.normalizedTitle).toBe(normalizeTitle('Estate Reliability Engineer'));
  });

  it('links to an existing active entry matched by alias without adding anything', async () => {
    const existing = await prisma.catalogRole.create({ data: { domainId, title: 'Site Reliability Engineer', normalizedTitle: normalizeTitle('Site Reliability Engineer'), source: 'curated' } });
    await prisma.catalogRoleAlias.create({ data: { roleId: existing.id, alias: 'SRE', normalizedAlias: normalizeTitle('SRE'), source: 'curated' } });

    const res = await postRole({ title: 'SRE' });

    expect({ linked: res.body.role.catalogRole?.id, catalogRoles: await prisma.catalogRole.count() }).toEqual({ linked: existing.id, catalogRoles: 1 });
  });

  it('does not link to a retired entry', async () => {
    await prisma.catalogRole.create({ data: { domainId, title: 'Legacy Operator', normalizedTitle: normalizeTitle('Legacy Operator'), source: 'curated', status: 'retired' } });

    const res = await postRole({ title: 'Legacy Operator', addToCatalog: true });

    expect(res.body.role.catalogRole).toBeNull();
  });

  it('does not publish a title that came from an ATS requisition, even with addToCatalog', async () => {
    installFakeAts({ 'ats.example.com': { requisitions: { 'REQ-9': { title: 'Requisition Only Title', description: JD } } } });
    const connected = await request(app).put('/api/admin/ats').set('Authorization', auth).send({ baseUrl: 'https://ats.example.com/api', apiKey: ATS_KEY });
    expect(connected.status).toBe(200);

    const res = await request(app).post('/api/roles').set('Authorization', auth).send({ sourceType: 'ats', atsRequisitionId: 'REQ-9', useLlm: false, domainId, addToCatalog: true });

    expect({ status: res.status, catalogRoles: await prisma.catalogRole.count() }).toEqual({ status: 201, catalogRoles: 0 });
  });

  it('refuses a non-boolean addToCatalog', async () => {
    const res = await postRole({ title: 'Estate Reliability Engineer', addToCatalog: 'yes' });

    expect(res.status).toBe(400);
  });
});
