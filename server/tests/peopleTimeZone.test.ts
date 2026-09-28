import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * Where a person is, recorded rather than guessed.
 *
 * HR sets the candidate's zone, because nobody else knows it: the browser that
 * would otherwise be asked belongs to the recruiter, who is usually somewhere
 * else entirely. A Questor user sets their own, because an expert seated on a
 * round may never open the console at all and email is the whole product to
 * them.
 *
 * Both are checked against the runtime's zone table on the way in. A stored
 * string nothing recognised would be formatted against later and silently
 * produce UTC, which is the same class of bug as having no zone at all but
 * harder to see.
 */

const app = createApp();

type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;
let bearer = '';
const auth = () => ({ Authorization: bearer });

beforeEach(async () => {
  await wipe();
  demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  bearer = `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email })}`;
});

describe('a candidate’s time zone', () => {
  const setZone = (timeZone: unknown) =>
    request(app).patch(`/api/candidates/${demo.candidateId}/time-zone`).set(auth()).send({ timeZone });

  it('is unset until HR says, never inferred', async () => {
    const res = await request(app).get(`/api/candidates/${demo.candidateId}`).set(auth());

    expect(res.body.candidate.timeZone).toBeNull();
  });

  it('is stored when HR sets it', async () => {
    await setZone('America/New_York');

    const res = await request(app).get(`/api/candidates/${demo.candidateId}`).set(auth());
    expect(res.body.candidate.timeZone).toBe('America/New_York');
  });

  it('can be cleared back to unknown', async () => {
    await setZone('America/New_York');

    const res = await setZone(null);

    expect({ status: res.status, timeZone: res.body.timeZone }).toEqual({ status: 200, timeZone: null });
  });

  it('refuses a zone the runtime does not know', async () => {
    expect((await setZone('Mars/Olympus_Mons')).status).toBe(400);
  });

  it('refuses a bare offset, which has no daylight-saving rules', async () => {
    expect((await setZone('+05:30')).status).toBe(400);
  });

  it('cannot be set on a candidate outside the caller’s organisation', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other Ltd' } });
    const outsider = await prisma.candidate.create({
      data: { tenantId: other.id, fullName: 'Someone Else', email: 'else@example.com', emailNormalized: 'else@example.com' },
    });

    const res = await request(app).patch(`/api/candidates/${outsider.id}/time-zone`).set(auth()).send({ timeZone: 'UTC' });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('can be given when the candidate is created', async () => {
    const res = await request(app).post('/api/candidates').set(auth())
      .send({ fullName: 'Nina Roy', email: 'nina.roy@example.com', roleId: demo.roleId, timeZone: 'Europe/Lisbon' });

    expect(res.body.candidate?.timeZone).toBe('Europe/Lisbon');
  });
});

/**
 * The scheduler has to be able to say "nobody has told me where this person
 * is", which means it has to be able to ask — and get back both the answer and
 * what is standing in for it.
 */
describe('what the scheduler is told about a candidate’s zone', () => {
  const ask = () => request(app).get(`/api/candidates/${demo.candidateId}/time-zone`).set(auth());

  it('says plainly that nobody has set one', async () => {
    const res = await ask();

    expect({ timeZone: res.body.timeZone, source: res.body.source }).toEqual({ timeZone: null, source: 'org_default' });
  });

  it('names the zone that will be used instead', async () => {
    const res = await ask();

    expect(res.body.orgTimeZone).toBe('Asia/Kolkata');
  });

  it('reports the candidate’s own once HR sets it', async () => {
    await request(app).patch(`/api/candidates/${demo.candidateId}/time-zone`).set(auth()).send({ timeZone: 'Europe/Berlin' });

    const res = await ask();

    expect({ timeZone: res.body.timeZone, source: res.body.source }).toEqual({ timeZone: 'Europe/Berlin', source: 'candidate' });
  });
});

describe('a user’s own time zone', () => {
  const setZone = (timeZone: unknown) =>
    request(app).patch('/api/auth/me/preferences').set(auth()).send({ timeZone });

  it('is unset until they choose one', async () => {
    const res = await request(app).get('/api/auth/me').set(auth());

    expect(res.body.user.timeZone).toBeNull();
  });

  it('is stored when they choose one', async () => {
    await setZone('Europe/London');

    const res = await request(app).get('/api/auth/me').set(auth());
    expect(res.body.user.timeZone).toBe('Europe/London');
  });

  it('refuses a zone the runtime does not know', async () => {
    expect((await setZone('Nowhere/Nothing')).status).toBe(400);
  });

  it('can be cleared, which puts them back on the organisation clock', async () => {
    await setZone('Europe/London');

    const res = await setZone(null);

    expect({ status: res.status, timeZone: res.body.timeZone }).toEqual({ status: 200, timeZone: null });
  });

  it('leaves the daily summary setting alone when only the zone is sent', async () => {
    await request(app).patch('/api/auth/me/preferences').set(auth()).send({ digestOptOut: true });

    await setZone('Europe/London');

    const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
    expect(user.digestOptOut).toBe(true);
  });
});
