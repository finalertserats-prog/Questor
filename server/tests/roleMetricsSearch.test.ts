import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

// GET /api/roles/metrics?q= — the roles page search. It reaches the JD and the
// scorecard, which the list payload does not carry, so it runs on the server.

const app = createApp();

async function makeUser(tenantId: string, email: string, role = 'admin') {
  const user = await prisma.user.create({ data: { tenantId, email, name: email, passwordHash: 'x', role } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

async function makeRole(tenantId: string, o: { title: string; sourceText?: string; profile?: unknown; olderProfile?: unknown }) {
  const role = await prisma.role.create({ data: { tenantId, title: o.title, status: 'approved', sourceText: o.sourceText ?? '' } });
  if (o.olderProfile !== undefined) {
    await prisma.roleScorecardVersion.create({ data: { roleId: role.id, version: 1, status: 'approved', profileJson: JSON.stringify(o.olderProfile) } });
  }
  await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, version: o.olderProfile === undefined ? 1 : 2, status: 'approved', profileJson: JSON.stringify(o.profile ?? {}) },
  });
  return role;
}

const search = (token: string, query: string) =>
  request(app).get(`/api/roles/metrics${query}`).set('Authorization', `Bearer ${token}`);

const titles = (body: { roles: Array<{ title: string }> }) => body.roles.map((r) => r.title).sort();

let tenantId = '';
let admin = { id: '', token: '' };

beforeEach(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Search Org' } });
  tenantId = tenant.id;
  admin = await makeUser(tenantId, 'admin@search.local');
  await makeRole(tenantId, { title: 'Backend Engineer', sourceText: 'You will own our payments ledger.' });
  await makeRole(tenantId, {
    title: 'Data Analyst',
    profile: {
      responsibilities: ['Build weekly retention dashboards'],
      competencies: [{ id: 'c1', name: 'Statistical reasoning', definition: 'Chooses the right significance test' }],
    },
  });
  await makeRole(tenantId, { title: 'Office Manager', sourceText: 'Keeps the office running.' });
});

describe('GET /api/roles/metrics?q=', () => {
  it('matches the role title', async () => {
    const res = await search(admin.token, '?q=backend');
    expect(titles(res.body)).toEqual(['Backend Engineer']);
  });

  it('matches the job description text', async () => {
    const res = await search(admin.token, '?q=payments%20ledger');
    expect(titles(res.body)).toEqual(['Backend Engineer']);
  });

  it('matches a scorecard responsibility', async () => {
    const res = await search(admin.token, '?q=retention');
    expect(titles(res.body)).toEqual(['Data Analyst']);
  });

  it('matches a scorecard competency name', async () => {
    const res = await search(admin.token, '?q=statistical');
    expect(titles(res.body)).toEqual(['Data Analyst']);
  });

  it('matches a scorecard competency definition', async () => {
    const res = await search(admin.token, '?q=significance');
    expect(titles(res.body)).toEqual(['Data Analyst']);
  });

  it('is case-insensitive across title, JD and scorecard', async () => {
    const res = await search(admin.token, '?q=RETENTION');
    const jd = await search(admin.token, '?q=PAYMENTS');
    const title = await search(admin.token, '?q=oFFice');
    expect([titles(res.body), titles(jd.body), titles(title.body)]).toEqual([['Data Analyst'], ['Backend Engineer'], ['Office Manager']]);
  });

  it('is case-insensitive beyond ASCII', async () => {
    await makeRole(tenantId, { title: 'Ingénieur Système' });
    const res = await search(admin.token, '?q=ING%C3%89NIEUR');
    expect(titles(res.body)).toEqual(['Ingénieur Système']);
  });

  it('searches only the latest scorecard version', async () => {
    await makeRole(tenantId, {
      title: 'Support Lead',
      olderProfile: { responsibilities: ['Run the night shift rota'] },
      profile: { responsibilities: ['Coach the support team'] },
    });
    const res = await search(admin.token, '?q=night%20shift');
    expect(res.body.roles).toEqual([]);
  });

  it('does not match on scorecard field names', async () => {
    const res = await search(admin.token, '?q=responsibilities');
    expect(res.body.roles).toEqual([]);
  });

  it('returns an empty list when nothing matches', async () => {
    const res = await search(admin.token, '?q=astronaut');
    expect(res.body.roles).toEqual([]);
  });

  it('trims the query', async () => {
    const res = await search(admin.token, '?q=%20%20backend%20%20');
    expect(titles(res.body)).toEqual(['Backend Engineer']);
  });

  it('leaves the dashboard summaries unfiltered', async () => {
    const res = await search(admin.token, '?q=backend');
    expect(res.body.kpis.activeRoles).toBe(3);
  });

  it('returns every role without q', async () => {
    const res = await search(admin.token, '');
    expect(res.body.roles).toHaveLength(3);
  });

  it('never finds a role the recruiter is not assigned', async () => {
    const recruiter = await makeUser(tenantId, 'rec@search.local', 'recruiter');
    const own = await makeRole(tenantId, { title: 'Backend Platform Engineer' });
    await prisma.roleAssignment.create({ data: { roleId: own.id, userId: recruiter.id } });
    const res = await search(recruiter.token, '?q=backend');
    expect(titles(res.body)).toEqual(['Backend Platform Engineer']);
  });

  it('never finds another tenant\'s role', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other Org' } });
    await makeRole(other.id, { title: 'Backend Wizard' });
    const res = await search(admin.token, '?q=backend');
    expect(titles(res.body)).toEqual(['Backend Engineer']);
  });

  it('skips a scorecard that is not valid JSON instead of failing the search', async () => {
    const role = await prisma.role.create({ data: { tenantId, title: 'Broken Card', status: 'approved' } });
    await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{not json' } });
    const res = await search(admin.token, '?q=broken');
    expect(titles(res.body)).toEqual(['Broken Card']);
  });
});

describe('GET /api/roles/metrics query validation', () => {
  it('rejects an unknown key', async () => {
    expect((await search(admin.token, '?q=a&tenantId=x')).status).toBe(400);
  });

  it('rejects a query longer than 200 characters', async () => {
    expect((await search(admin.token, `?q=${'a'.repeat(201)}`)).status).toBe(400);
  });

  it('accepts a query of exactly 200 characters', async () => {
    expect((await search(admin.token, `?q=${'a'.repeat(200)}`)).status).toBe(200);
  });

  it('rejects an empty query', async () => {
    expect((await search(admin.token, '?q=%20%20')).status).toBe(400);
  });

  it('rejects a repeated q', async () => {
    expect((await search(admin.token, '?q=a&q=b')).status).toBe(400);
  });
});
