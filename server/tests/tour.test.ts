import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';

/**
 * The guided tour's first-run flag lives on the user, server-side, so finishing
 * or skipping the tour on one browser keeps it away on every other. A user can
 * only ever mark their own; nothing in the request names whose flag to set.
 */

const app = createApp();
const PASS_ADMIN = 'tour-admin-correct-horse-battery';
const PASS_MEMBER = 'tour-member-correct-horse-battery';
const PASS_OTHER = 'tour-other-correct-horse-battery';
const PASS_FRESH = 'tour-fresh-correct-horse-battery';

let admin = '';
let member = '';
let other = '';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await wipe();
  const a = await request(app).post('/api/auth/register').send({ email: 'admin@tour.local', password: PASS_ADMIN, name: 'Tour Admin', tenantName: 'Tour Org' });
  expect(a.status).toBe(201);
  admin = a.body.token;

  const created = await request(app).post('/api/admin/users').set(bearer(admin))
    .send({ email: 'member@tour.local', password: PASS_MEMBER, name: 'Tour Member', role: 'recruiter' });
  expect(created.status).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email: 'member@tour.local', password: PASS_MEMBER });
  member = login.body.token;

  const b = await request(app).post('/api/auth/register').send({ email: 'admin@other-tour.local', password: PASS_OTHER, name: 'Other Admin', tenantName: 'Other Org' });
  expect(b.status).toBe(201);
  other = b.body.token;
});

describe('first-run tour flag', () => {
  it('is null for a user who has never finished or skipped the tour', async () => {
    const res = await request(app).get('/api/auth/me').set(bearer(member));
    expect(res.body.user.tourCompletedAt).toBeNull();
  });

  it('is exposed on the login response as well, so the app knows before its first /me', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'member@tour.local', password: PASS_MEMBER });
    expect(res.body.user).toHaveProperty('tourCompletedAt', null);
  });

  it('refuses to be set without a session', async () => {
    const res = await request(app).post('/api/auth/tour/complete');
    expect(res.status).toBe(401);
  });

  it('is set to a timestamp when the user marks the tour done', async () => {
    const res = await request(app).post('/api/auth/tour/complete').set(bearer(member));
    expect(res.status).toBe(200);
    expect(Number.isNaN(Date.parse(res.body.tourCompletedAt))).toBe(false);
  });

  it('is reported by /me afterwards', async () => {
    const res = await request(app).get('/api/auth/me').set(bearer(member));
    expect(typeof res.body.user.tourCompletedAt).toBe('string');
  });

  it('keeps the original timestamp when marked done a second time', async () => {
    const first = (await request(app).get('/api/auth/me').set(bearer(member))).body.user.tourCompletedAt;
    const again = await request(app).post('/api/auth/tour/complete').set(bearer(member));
    expect(again.body.tourCompletedAt).toBe(first);
  });

  it('survives signing out and back in', async () => {
    await request(app).post('/api/auth/logout').set(bearer(member));
    const login = await request(app).post('/api/auth/login').send({ email: 'member@tour.local', password: PASS_MEMBER });
    expect(typeof login.body.user.tourCompletedAt).toBe('string');
  });

  it('only ever marks the caller, whatever user id the body names', async () => {
    // A colleague whose tour has not run: if the body were honoured, this is
    // the flag that would be set.
    const created = await request(app).post('/api/admin/users').set(bearer(admin))
      .send({ email: 'fresh@tour.local', password: PASS_FRESH, name: 'Fresh Member', role: 'recruiter' });
    expect(created.status).toBe(201);
    const freshId: string = created.body.user.id;
    const res = await request(app).post('/api/auth/tour/complete').set(bearer(admin)).send({ userId: freshId, id: freshId });
    expect(res.status).toBe(200);
    const fresh = await request(app).post('/api/auth/login').send({ email: 'fresh@tour.local', password: PASS_FRESH });
    expect(fresh.body.user.tourCompletedAt).toBeNull();
  });

  it('marks the caller when the body names someone else', async () => {
    const me = await request(app).get('/api/auth/me').set(bearer(admin));
    expect(typeof me.body.user.tourCompletedAt).toBe('string');
  });

  it('leaves a user in another organisation untouched', async () => {
    const res = await request(app).get('/api/auth/me').set(bearer(other));
    expect(res.body.user.tourCompletedAt).toBeNull();
  });
});
