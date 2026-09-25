import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { signToken } from '../src/services/auth.js';
import { recordAssessmentOpened } from '../src/services/assessmentViews.js';

// HR-Box: GET /api/dashboard/needs-you and its count. What waits on the caller
// (only what their account may act on, only their candidates), what is coming
// up, what was done, and what each interviewer is doing.

const app = createApp();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

async function setup() {
  const tenant = await prisma.tenant.create({ data: { name: 'Box Org' } });
  const make = async (email: string, role: string, name = email) => {
    const user = await prisma.user.create({ data: { tenantId: tenant.id, email, name, passwordHash: 'x', role } });
    return { id: user.id, token: signToken({ userId: user.id, tenantId: tenant.id, role, email }) };
  };
  const recruiter = await make('rec@box.local', 'recruiter', 'Kavya Sharma');
  const manager = await make('mgr@box.local', 'manager', 'Rahul Verma');
  const outsider = await make('out@box.local', 'recruiter');
  const auditor = await make('aud@box.local', 'auditor');
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
  await prisma.roleAssignment.createMany({ data: [{ roleId: role.id, userId: recruiter.id }, { roleId: role.id, userId: manager.id }] });
  const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
  const candidate = (fullName: string) => prisma.candidate.create({
    data: { tenantId: tenant.id, roleId: role.id, fullName, email: `${fullName.replace(/\s+/g, '.').toLowerCase()}@m.local` },
  });
  const session = (candidateId: string, state: string, extra: Record<string, unknown> = {}) => prisma.interviewSession.create({
    data: { tenantId: tenant.id, candidateId, roleId: role.id, scorecardId: scorecard.id, state, ...extra },
  });
  const assessment = (sessionId: string) => prisma.assessmentVersion.create({
    data: { sessionId, scorecardId: scorecard.id, recommendation: 'CONSIDER', confidence: 0.7, evidenceCoverage: 0.6, resultJson: '{}' },
  });
  return { tenant, recruiter, manager, outsider, auditor, role, scorecard, candidate, session, assessment };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const feed = (token: string, query = '') => request(app).get(`/api/dashboard/needs-you${query}`).set('Authorization', `Bearer ${token}`);
const kindsOf = (body: { needsYou: { items: { kind: string }[] } }) => body.needsYou.items.map((i) => i.kind);

async function reviewReady(s: Setup, name = 'Arjun Mehta') {
  const c = await s.candidate(name);
  const sess = await s.session(c.id, 'REVIEW_READY', { completedAt: ago(3 * HOUR), personaJson: JSON.stringify({ interviewerId: 'avery' }) });
  const a = await s.assessment(sess.id);
  return { candidate: c, session: sess, assessment: a };
}

async function invited(s: Setup, name: string, expiresInMs: number) {
  const c = await s.candidate(name);
  const sess = await s.session(c.id, 'INVITED');
  await prisma.invitation.create({ data: { sessionId: sess.id, tokenHash: `h-${sess.id}`, status: 'sent', sentAt: ago(12 * DAY), expiresAt: ahead(expiresInMs) } });
  return sess;
}

beforeEach(async () => { await wipe(); });

describe('needs-you queue', () => {
  it('shows a hiring manager a review that is ready', async () => {
    const s = await setup();
    await reviewReady(s);
    const res = await feed(s.manager.token);
    expect(kindsOf(res.body)).toEqual(['review']);
  });

  it('shows the same review to the recruiter who owns the candidate', async () => {
    const s = await setup();
    await reviewReady(s);
    const res = await feed(s.recruiter.token);
    expect(kindsOf(res.body)).toEqual(['review']);
  });

  it('offers the recruiter the assessment to read, not a verdict they could not record', async () => {
    const s = await setup();
    const { assessment } = await reviewReady(s);
    const res = await feed(s.recruiter.token);
    expect([res.body.needsYou.items[0].canAct, res.body.needsYou.items[0].action])
      .toEqual([false, { label: 'Open the assessment', to: `/assessments/${assessment.id}` }]);
  });

  it('still leaves a review off an auditor queue, who may not read assessments', async () => {
    const s = await setup();
    await reviewReady(s);
    const res = await feed(s.auditor.token);
    expect(res.status).toBe(403);
  });

  it('tells neither role what the AI recommended', async () => {
    const s = await setup();
    await reviewReady(s);
    const [asRecruiter, asManager] = await Promise.all([feed(s.recruiter.token), feed(s.manager.token)]);
    // The assessment's own recommendation is CONSIDER, and a blind-review
    // organisation withholds it until the reviewer has judged. The queue row
    // never carried it and must not start: it says an assessment is ready, not
    // what it concluded.
    const rows = JSON.stringify([asRecruiter.body.needsYou.items[0], asManager.body.needsYou.items[0]]);
    expect([/CONSIDER|PROCEED|DO_NOT_PROGRESS|recommendation|confidence|score/i.test(rows), asRecruiter.body.needsYou.items.length])
      .toEqual([false, 1]);
  });

  it('lists an invitation that closes within two days for the recruiter', async () => {
    const s = await setup();
    await invited(s, 'Sofia Alvarez', DAY);
    const res = await feed(s.recruiter.token);
    expect(kindsOf(res.body)).toEqual(['invitation_expiring']);
  });

  it('leaves out an invitation with more than two days left', async () => {
    const s = await setup();
    await invited(s, 'Sofia Alvarez', 3 * DAY);
    const res = await feed(s.recruiter.token);
    expect(kindsOf(res.body)).toEqual([]);
  });

  it('leaves out an expiring invitation on an archived role', async () => {
    const s = await setup();
    await invited(s, 'Sofia Alvarez', DAY);
    await prisma.role.update({ where: { id: s.role.id }, data: { status: 'archived' } });
    const res = await feed(s.recruiter.token);
    expect(kindsOf(res.body)).toEqual([]);
  });

  it('lists an interview that stopped part-way', async () => {
    const s = await setup();
    const c = await s.candidate('Daniel Okafor');
    await s.session(c.id, 'INCOMPLETE', { interruptedAt: ago(26 * HOUR) });
    const res = await feed(s.recruiter.token);
    expect(kindsOf(res.body)).toEqual(['stalled']);
  });

  it('puts a candidate asking for a person ahead of older work', async () => {
    const s = await setup();
    await reviewReady(s);
    const c = await s.candidate('Meera Iyer');
    const closed = await s.session(c.id, 'CLOSED');
    await prisma.candidateHumanRequest.create({
      data: { tenantId: s.tenant.id, candidateId: c.id, sessionId: closed.id, tokenHash: `hr-${closed.id}`, expiresAt: ahead(DAY), status: 'REQUESTED', requestedAt: ago(18 * 60_000) },
    });
    const res = await feed(s.manager.token);
    expect([kindsOf(res.body), res.body.needsYou.items[0].urgent]).toEqual([['human_request', 'review'], true]);
  });

  it('leaves out candidates the caller is not assigned', async () => {
    const s = await setup();
    await invited(s, 'Sofia Alvarez', DAY);
    const res = await feed(s.outsider.token);
    expect(res.body.needsYou.total).toBe(0);
  });

  it('refuses an auditor, who may not read candidates', async () => {
    const s = await setup();
    const res = await feed(s.auditor.token);
    expect(res.status).toBe(403);
  });

  it('refuses a page size the lists do not offer', async () => {
    const s = await setup();
    const res = await feed(s.manager.token, '?pageSize=7');
    expect(res.status).toBe(400);
  });

  it('pages the queue on the server', async () => {
    const s = await setup();
    for (let i = 0; i < 27; i += 1) await invited(s, `Person ${i}`, DAY);
    const res = await feed(s.recruiter.token, '?page=2&pageSize=25');
    expect([res.body.needsYou.total, res.body.needsYou.items.length]).toEqual([27, 2]);
  });

  it('points a review at its assessment, and asks the manager to review it', async () => {
    const s = await setup();
    const { assessment } = await reviewReady(s);
    const res = await feed(s.manager.token);
    expect([res.body.needsYou.items[0].canAct, res.body.needsYou.items[0].action])
      .toEqual([true, { label: 'Review', to: `/assessments/${assessment.id}` }]);
  });

  it('names the interviewer who ran it', async () => {
    const s = await setup();
    await reviewReady(s);
    const res = await feed(s.manager.token);
    expect(res.body.needsYou.items[0].facts.interviewerName).toBe('Avery');
  });
});

describe('who else has opened it', () => {
  it('shows a colleague who opened the assessment', async () => {
    const s = await setup();
    const { assessment } = await reviewReady(s);
    await recordAssessmentOpened({ userId: s.recruiter.id, tenantId: s.tenant.id, role: 'recruiter', email: 'rec@box.local' }, assessment.id);
    const res = await feed(s.manager.token);
    expect(res.body.needsYou.items[0].openedBy).toEqual([{ userId: s.recruiter.id, name: 'Kavya Sharma', initials: 'KS' }]);
  });

  it('does not list the caller as someone else who looked', async () => {
    const s = await setup();
    const { assessment } = await reviewReady(s);
    await recordAssessmentOpened({ userId: s.manager.id, tenantId: s.tenant.id, role: 'manager', email: 'mgr@box.local' }, assessment.id);
    const res = await feed(s.manager.token);
    expect(res.body.needsYou.items[0].openedBy).toEqual([]);
  });

  it('records a look when a colleague opens the assessment page', async () => {
    const s = await setup();
    const { assessment } = await reviewReady(s);
    await request(app).get(`/api/assessments/${assessment.id}`).set('Authorization', `Bearer ${s.recruiter.token}`);
    const res = await feed(s.manager.token);
    expect(res.body.needsYou.items[0].openedBy.map((l: { name: string }) => l.name)).toEqual(['Kavya Sharma']);
  });

  it('records one look per person per hour, not one per page load', async () => {
    const s = await setup();
    const { assessment } = await reviewReady(s);
    const auth = { userId: s.recruiter.id, tenantId: s.tenant.id, role: 'recruiter', email: 'rec@box.local' };
    await recordAssessmentOpened(auth, assessment.id);
    await recordAssessmentOpened(auth, assessment.id);
    expect(await prisma.auditEvent.count({ where: { action: 'assessment.opened', entityId: assessment.id } })).toBe(1);
  });

  it('stores no more than who and which assessment', async () => {
    const s = await setup();
    const { assessment } = await reviewReady(s);
    await recordAssessmentOpened({ userId: s.recruiter.id, tenantId: s.tenant.id, role: 'recruiter', email: 'rec@box.local' }, assessment.id);
    const row = await prisma.auditEvent.findFirst({ where: { action: 'assessment.opened' } });
    expect([row?.actorId, row?.entityId, row?.beforeJson, row?.afterJson]).toEqual([s.recruiter.id, assessment.id, '', '']);
  });
});

describe('needs-you count', () => {
  it('counts what waits and how much of it is urgent', async () => {
    const s = await setup();
    await reviewReady(s);
    const c = await s.candidate('Ben Handoff');
    await s.session(c.id, 'MANUAL_HANDOFF');
    const res = await request(app).get('/api/dashboard/needs-you/count').set('Authorization', `Bearer ${s.manager.token}`);
    expect(res.body).toEqual({ total: 2, urgent: 1 });
  });
});

describe('coming up, done and the crew', () => {
  it('lists an interview booked for later today', async () => {
    const s = await setup();
    const c = await s.candidate('Tomas Garcia');
    await s.session(c.id, 'INVITED', { scheduledAt: ahead(5 * 60_000), personaJson: JSON.stringify({ interviewerId: 'theo' }) });
    const res = await feed(s.recruiter.token);
    expect(res.body.comingUp.map((u: { candidate: { name: string }; interviewerName: string }) => [u.candidate.name, u.interviewerName])).toEqual([['Tomas Garcia', 'Theo']]);
  });

  it('shows an interviewer live with the candidate they are interviewing', async () => {
    const s = await setup();
    const c = await s.candidate('Priya Raman');
    await s.session(c.id, 'ASSESSING', { startedAt: ago(10 * 60_000), personaJson: JSON.stringify({ interviewerId: 'maya' }) });
    const res = await feed(s.recruiter.token);
    expect(res.body.crew.find((m: { id: string }) => m.id === 'maya')).toMatchObject({ status: 'live', candidateFirstName: 'Priya' });
  });

  it('does not show a long-quiet waiting room as live', async () => {
    const s = await setup();
    const c = await s.candidate('Quiet Person');
    const sess = await s.session(c.id, 'WAITING', { personaJson: JSON.stringify({ interviewerId: 'maya' }) });
    await prisma.interviewSession.update({ where: { id: sess.id }, data: { updatedAt: ago(5 * HOUR) } });
    const res = await feed(s.recruiter.token);
    expect(res.body.comingUp).toEqual([]);
  });

  it('lists an interview completed this week as done', async () => {
    const s = await setup();
    await reviewReady(s);
    const res = await feed(s.recruiter.token);
    expect(res.body.doneRecently.map((d: { kind: string; by: string }) => [d.kind, d.by])).toEqual([['interview_completed', 'Avery']]);
  });

  it('lists all five interviewers', async () => {
    const s = await setup();
    const res = await feed(s.recruiter.token);
    expect(res.body.crew.map((m: { name: string }) => m.name)).toEqual(['Avery', 'Maya', 'Adrian', 'Elena', 'Theo']);
  });
});
