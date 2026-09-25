import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { anonymiseAfterDays, runAnonymisationSweep } from '../src/services/anonymise.js';

/**
 * The dry run an operator sees before anything is severed.
 *
 * Irreversible work on real customer data must be inspectable first — the same
 * rule the retention preview follows, and the same construction: the preview is
 * built from the query the sweep uses, so the two cannot describe different
 * sets of people. It matters more here than it does for a purge, because an
 * anonymisation is quiet. The interview is still in the list afterwards; only
 * the person is gone.
 */

const app = createApp();
const DAY_MS = 24 * 60 * 60 * 1000;

async function seedAndLogIn(completedAt: Date) {
  await wipe();
  const ids = await createDemoData();
  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: { state: 'COMPLETED', completedAt },
  });
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ids, auth: `Bearer ${login.body.token as string}` };
}

const longAgo = () => new Date(Date.now() - (anonymiseAfterDays() + 1) * DAY_MS);

describe('GET /api/admin/anonymisation/preview', () => {
  beforeEach(async () => { await wipe(); });

  it('lists the candidate who would be severed, by name, while they still have one', async () => {
    const { ids, auth } = await seedAndLogIn(longAgo());

    const res = await request(app).get('/api/admin/anonymisation/preview').set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0]).toMatchObject({ candidateId: ids.candidateId, candidateName: 'Priya Sharma' });
  });

  it('changes nothing — it is a question, not an instruction', async () => {
    const { ids, auth } = await seedAndLogIn(longAgo());

    await request(app).get('/api/admin/anonymisation/preview').set('Authorization', auth);

    const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: ids.candidateId } });
    expect({ name: candidate.fullName, anonymisedAt: candidate.anonymisedAt }).toEqual({ name: 'Priya Sharma', anonymisedAt: null });
  });

  it('lists nobody while the interview is inside the window', async () => {
    const { auth } = await seedAndLogIn(new Date());

    const res = await request(app).get('/api/admin/anonymisation/preview').set('Authorization', auth);

    expect(res.body.dueCount).toBe(0);
  });

  it('answers "what falls due next year?" as well as "what goes tonight?"', async () => {
    const { auth } = await seedAndLogIn(new Date());
    const afterTheWindow = new Date(Date.now() + (anonymiseAfterDays() + 1) * DAY_MS).toISOString();

    const res = await request(app).get(`/api/admin/anonymisation/preview?asOf=${afterTheWindow}`).set('Authorization', auth);

    expect(res.body.dueCount).toBe(1);
  });

  it('says what it would remove and what it would not, where the operator is deciding', async () => {
    const { auth } = await seedAndLogIn(longAgo());

    const res = await request(app).get('/api/admin/anonymisation/preview').set('Authorization', auth);

    expect(res.body.keeps).toMatch(/transcript/);
    expect(res.body.caveat).toMatch(/former employer/);
  });

  it('reports that nothing is switched on, so a preview is never mistaken for a sweep that ran', async () => {
    const { auth } = await seedAndLogIn(longAgo());

    const res = await request(app).get('/api/admin/anonymisation/preview').set('Authorization', auth);

    expect(res.body.enabled).toBe(false);
  });

  it('records the look-up, because listing the people about to be severed is itself an access to their data', async () => {
    const { auth } = await seedAndLogIn(longAgo());

    await request(app).get('/api/admin/anonymisation/preview').set('Authorization', auth);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'anonymisation.previewed' } });
    expect(event.afterJson).not.toMatch(/Priya|Sharma/);
  });

  it('refuses a caller without the retention capability', async () => {
    await wipe();
    const ids = await createDemoData();
    await prisma.user.update({ where: { id: ids.userId }, data: { role: 'interviewer' } });
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });

    const res = await request(app).get('/api/admin/anonymisation/preview')
      .set('Authorization', `Bearer ${login.body.token as string}`);

    expect(res.status).toBe(403);
  });
});

/**
 * What an anonymised application looks like to the rest of the product.
 *
 * Questor writes one candidate row per application and finds returning people
 * by address. An anonymised row has no address, so it must be kept out of that
 * search rather than left to fall through it — without this, every anonymised
 * candidate in the organisation groups under the same empty key and is offered
 * as one person to reuse.
 */
describe('a candidate who has been anonymised', () => {
  beforeEach(async () => { await wipe(); });

  it('is not offered as somebody to set up for another role', async () => {
    const { auth } = await seedAndLogIn(longAgo());
    await runAnonymisationSweep(new Date());

    const res = await request(app).get('/api/candidates/search?q=Anonymised').set('Authorization', auth);

    expect(res.body.people).toEqual([]);
  });

  it('still leaves a real applicant findable, so the exclusion is narrow', async () => {
    const { ids, auth } = await seedAndLogIn(longAgo());
    await prisma.candidate.create({
      data: { tenantId: ids.tenantId, roleId: ids.roleId, fullName: 'Rohit Nair', email: 'rohit.nair@example.com', emailNormalized: 'rohit.nair@example.com' },
    });
    await runAnonymisationSweep(new Date());

    const res = await request(app).get('/api/candidates/search?q=Rohit').set('Authorization', auth);

    expect(res.body.people).toHaveLength(1);
  });
});

/**
 * The mapping a reused application leaves behind.
 *
 * Questor writes one candidate row per application, and reusing a person for a
 * second role writes `candidate.created` under the NEW row carrying the old
 * row's id. Anonymise the old application while the new one is still inside
 * its window and that audit row is not the old one's to clear - it is filed
 * under the new one. The handle pass removes an address and a slug from it.
 * It did not remove ids, so one query on `copiedFromCandidateId` returned a
 * row that still has a name.
 */
describe('a reused candidate', () => {
  beforeEach(async () => { await wipe(); });

  it('leaves nothing pointing from the anonymised application at the named one', async () => {
    const { ids } = await seedAndLogIn(longAgo());
    const newer = await prisma.candidate.create({
      data: {
        tenantId: ids.tenantId, roleId: ids.roleId, fullName: 'Priya Sharma',
        email: 'priya.sharma@example.com', emailNormalized: 'priya.sharma@example.com',
      },
    });
    const mapping = await prisma.auditEvent.create({
      data: {
        tenantId: ids.tenantId, actorId: ids.userId, actorType: 'user',
        action: 'candidate.created', entityType: 'Candidate', entityId: newer.id,
        afterJson: JSON.stringify({ copiedFromCandidateId: ids.candidateId, roleId: ids.roleId }),
      },
    });

    await runAnonymisationSweep(new Date());

    const after = (await prisma.auditEvent.findUniqueOrThrow({ where: { id: mapping.id } })).afterJson;
    expect(after).not.toContain(ids.candidateId);
    // The newer application is untouched: it is somebody the organisation is
    // still recruiting, and its own record keeps its shape.
    expect(after).toContain(ids.roleId);
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: newer.id } })).fullName).toBe('Priya Sharma');
  });
});
