import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * What the interview pages need to lead HR to the next step: who the interview
 * is for, which actions its state allows, the verdict a person gave, and the
 * signed-in user's capabilities so nothing is offered that only ends in 403.
 */

const app = createApp();
type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;
let adminToken = '';
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

beforeEach(async () => {
  await wipe();
  demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  adminToken = signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
});

async function sessionIn(state: string) {
  return prisma.interviewSession.create({
    data: { tenantId: demo.tenantId, candidateId: demo.candidateId, roleId: demo.roleId, scorecardId: demo.scorecardId, state },
  });
}

const detail = async (id: string) => (await request(app).get(`/api/interviews/${id}`).set(auth())).body;

describe('GET /interviews/:id context', () => {
  it('names the candidate and the role', async () => {
    const body = await detail(demo.sessionId);
    const role = await prisma.role.findUniqueOrThrow({ where: { id: demo.roleId } });
    expect([body.candidate, body.role]).toEqual([{ id: demo.candidateId, name: 'Priya Sharma' }, { id: demo.roleId, title: role.title }]);
  });
});

describe('GET /interviews/:id actions', () => {
  it.each([
    ['PROVISIONED', { cancel: true, schedule: true, retake: false, assessPartial: false, reopen: false, sendInvitation: true, resend: true }],
    ['ACCEPTED', { cancel: true, schedule: true, retake: false, assessPartial: false, reopen: false, sendInvitation: false, resend: true }],
    ['CONSENTED', { cancel: false, schedule: true, retake: false, assessPartial: false, reopen: false, sendInvitation: false, resend: true }],
    ['RESCHEDULE_REQUIRED', { cancel: true, schedule: true, retake: false, assessPartial: false, reopen: false, sendInvitation: true, resend: false }],
    ['MANUAL_HANDOFF', { cancel: false, schedule: false, retake: false, assessPartial: false, reopen: true, sendInvitation: false, resend: false }],
    ['INCOMPLETE', { cancel: false, schedule: false, retake: true, assessPartial: true, reopen: false, sendInvitation: false, resend: false }],
    ['TECHNICAL_FAILURE', { cancel: true, schedule: false, retake: true, assessPartial: false, reopen: false, sendInvitation: false, resend: false }],
    ['NO_SHOW', { cancel: false, schedule: true, retake: false, assessPartial: false, reopen: false, sendInvitation: false, resend: false }],
    ['CANCELLED', { cancel: false, schedule: false, retake: false, assessPartial: false, reopen: false, sendInvitation: false, resend: false }],
    ['REVIEW_READY', { cancel: false, schedule: false, retake: false, assessPartial: false, reopen: false, sendInvitation: false, resend: false }],
  ])('in %s allows %o', async (state, expected) => {
    const session = await sessionIn(state);
    expect((await detail(session.id)).actions).toEqual(expected);
  });

  it('offers no retake once the attempts are used up', async () => {
    const session = await sessionIn('INCOMPLETE');
    await prisma.interviewSession.update({ where: { id: session.id }, data: { attemptNumber: 2 } });
    expect((await detail(session.id)).actions.retake).toBe(false);
  });
});

describe('scheduling a no-show again', () => {
  it('moves the interview to awaiting a new date and saves the time', async () => {
    const session = await sessionIn('NO_SHOW');
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await request(app).post(`/api/interviews/${session.id}/schedule`).set(auth()).send({ scheduledAt: at });
    const after = await prisma.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    expect([res.status, after.state, after.scheduledAt?.toISOString()]).toEqual([200, 'RESCHEDULE_REQUIRED', at]);
  });

  it('still refuses a finished interview', async () => {
    const session = await sessionIn('CLOSED');
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await request(app).post(`/api/interviews/${session.id}/schedule`).set(auth()).send({ scheduledAt: at });
    expect(res.status).toBe(409);
  });
});

describe('GET /interviews human verdict', () => {
  async function assessed(disposition: string | null) {
    await prisma.interviewSession.update({ where: { id: demo.sessionId }, data: { state: disposition ? 'HUMAN_REVIEWED' : 'REVIEW_READY' } });
    const assessment = await prisma.assessmentVersion.create({
      data: { sessionId: demo.sessionId, scorecardId: demo.scorecardId, recommendation: 'PROCEED', confidence: 0.8, evidenceCoverage: 0.7, resultJson: '{}' },
    });
    if (disposition) {
      await prisma.humanReview.create({
        data: { assessmentId: assessment.id, reviewerId: demo.userId, status: 'COMPLETED', disposition, reason: 'Reviewed.', completedAt: new Date() },
      });
    }
  }
  const row = async () => ((await request(app).get('/api/interviews').set(auth())).body.sessions as Array<{ id: string; recommendation: string | null; humanRecommendation: string | null }>)
    .find((s) => s.id === demo.sessionId);

  it('reports the reviewer verdict alongside the AI one', async () => {
    await assessed('DO_NOT_PROGRESS');
    const r = await row();
    expect([r?.recommendation, r?.humanRecommendation]).toEqual(['PROCEED', 'DO_NOT_PROGRESS']);
  });

  it('is null before anyone has reviewed', async () => {
    await assessed(null);
    expect((await row())?.humanRecommendation).toBeNull();
  });
});

describe('GET /auth/me capabilities', () => {
  it('lists what a recruiter may do, without assessment review', async () => {
    const recruiter = await prisma.user.create({ data: { tenantId: demo.tenantId, email: 'rec@questor.local', name: 'Rec', passwordHash: 'x', role: 'recruiter' } });
    const token = signToken({ userId: recruiter.id, tenantId: demo.tenantId, role: 'recruiter', email: recruiter.email });
    const caps: string[] = (await request(app).get('/api/auth/me').set(auth(token))).body.user.capabilities;
    expect([caps.includes('candidate:create'), caps.includes('assessment:review')]).toEqual([true, false]);
  });
});
