import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';

/**
 * Organisation links: each organisation has its own login URL (/o/:slug).
 * The slug is enforced on the server — a user can only sign in through their
 * own organisation's link.
 *
 * Organisations can now also be found by the first letters of their name,
 * because sign-in begins by choosing one and a slug nobody told you is a dead
 * end. The tests at the foot of this file pin the limits that keep that from
 * becoming a customer list anyone can download.
 */

const app = createApp();
const PASS_A = 'org-a-correct-horse-battery';
const PASS_B = 'org-b-correct-horse-battery';
const PASS_MEMBER = 'member-correct-horse-battery';

let adminA = '';
let adminB = '';
let memberA = '';

beforeAll(async () => {
  await wipe();
  const a = await request(app).post('/api/auth/register').send({ email: 'admin@org-a.local', password: PASS_A, name: 'Admin A', tenantName: 'Org A' });
  expect(a.status).toBe(201);
  adminA = a.body.token;
  const b = await request(app).post('/api/auth/register').send({ email: 'admin@org-b.local', password: PASS_B, name: 'Admin B', tenantName: 'Org B' });
  expect(b.status).toBe(201);
  adminB = b.body.token;

  expect((await request(app).patch('/api/admin/org').set('Authorization', `Bearer ${adminA}`).send({ slug: 'org-a' })).status).toBe(200);
  expect((await request(app).patch('/api/admin/org').set('Authorization', `Bearer ${adminB}`).send({ slug: 'org-b' })).status).toBe(200);

  const member = await request(app).post('/api/admin/users').set('Authorization', `Bearer ${adminA}`)
    .send({ email: 'member@org-a.local', password: PASS_MEMBER, name: 'Member A', role: 'recruiter' });
  expect(member.status).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email: 'member@org-a.local', password: PASS_MEMBER });
  memberA = login.body.token;
});

describe('public organisation lookup', () => {
  it('returns only the name and slug for a known organisation', async () => {
    const res = await request(app).get('/api/orgs/org-a');
    expect(res.body).toEqual({ org: { name: 'Org A', slug: 'org-a' } });
  });

  it('returns 404 for an unknown organisation', async () => {
    const res = await request(app).get('/api/orgs/no-such-org');
    expect(res.status).toBe(404);
  });
});

describe('signing in through an organisation link', () => {
  it('lets a user sign in through their own organisation', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'member@org-a.local', password: PASS_MEMBER, orgSlug: 'org-a' });
    expect(res.status).toBe(200);
  });

  it("rejects a user signing in through another organisation's link", async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'member@org-a.local', password: PASS_MEMBER, orgSlug: 'org-b' });
    expect(res.status).toBe(401);
  });

  it('gives the same error as a wrong password, so organisation membership is not revealed', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'member@org-a.local', password: PASS_MEMBER, orgSlug: 'org-b' });
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('still allows sign-in without an organisation link', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'member@org-a.local', password: PASS_MEMBER });
    expect(res.status).toBe(200);
  });
});

describe('setting an organisation slug', () => {
  it('rejects a slug with invalid characters', async () => {
    const res = await request(app).patch('/api/admin/org').set('Authorization', `Bearer ${adminA}`).send({ slug: 'Org A!' });
    expect(res.status).toBe(400);
  });

  it("rejects a slug already used by another organisation", async () => {
    const res = await request(app).patch('/api/admin/org').set('Authorization', `Bearer ${adminA}`).send({ slug: 'org-b' });
    expect(res.status).toBe(409);
  });

  it('denies a recruiter', async () => {
    const res = await request(app).patch('/api/admin/org').set('Authorization', `Bearer ${memberA}`).send({ slug: 'org-a-new' });
    expect(res.status).toBe(403);
  });
});


/**
 * Finding an organisation by the first letters of its name. Every limit below
 * is a disclosure boundary rather than a preference: the names ARE the
 * customer list.
 */
describe('organisation search', () => {
  beforeEach(async () => {
    await wipe();
    await prisma.tenant.create({ data: { name: 'ScaleHealthTech', slug: 'scalehealthtech' } });
    await prisma.tenant.create({ data: { name: 'Scafolding Partners', slug: 'scafolding' } });
    await prisma.tenant.create({ data: { name: 'Unlisted Org' } });
  });

  it('finds an organisation from the first letters of its name', async () => {
    const res = await request(app).get('/api/orgs?q=sca');

    expect(res.body.orgs.map((o: { slug: string }) => o.slug)).toContain('scalehealthtech');
  });

  it('ignores case, so nobody has to guess the capitals', async () => {
    const res = await request(app).get('/api/orgs?q=SCALEH');

    expect(res.body.orgs.map((o: { slug: string }) => o.slug)).toEqual(['scalehealthtech']);
  });

  it('answers nothing for a query too short to be a real attempt', async () => {
    const res = await request(app).get('/api/orgs?q=sc');

    expect(res.body.orgs).toEqual([]);
  });

  it('matches a prefix and not a substring, so sector words do not surface clients', async () => {
    const res = await request(app).get('/api/orgs?q=health');

    expect(res.body.orgs).toEqual([]);
  });

  it('never returns an organisation with no sign-in link, which nobody could sign into anyway', async () => {
    const res = await request(app).get('/api/orgs?q=unlisted');

    expect(res.body.orgs).toEqual([]);
  });
});
