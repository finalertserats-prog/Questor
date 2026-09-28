import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { getDashboardMetrics } from '../src/services/dashboardMetrics.js';

const app = createApp();
let token = '';
let tenantId = '';
let userId = '';
let candidateId = '';
let roleId = '';
let scorecardId = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await wipe();
  const demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  tenantId = user.tenantId;
  userId = user.id;
  token = signToken({ userId: user.id, tenantId, role: user.role, email: user.email });
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
  candidateId = session.candidateId;
  roleId = session.roleId;
  scorecardId = session.scorecardId;
});

describe('inviting many candidates at once', () => {
  it('refuses a batch larger than the ceiling', async () => {
    const rows = Array.from({ length: 201 }, () => ({ candidateId }));

    const res = await request(app).post('/api/interviews/bulk-invite').set(auth()).send(rows);

    expect(res.status).toBe(400);
  });
});

describe('scheduling an interview', () => {
  it('refuses a date that is not a date instead of failing inside the database', async () => {
    const session = await prisma.interviewSession.create({ data: { tenantId, candidateId, roleId, scorecardId, state: 'PROVISIONED' } });

    const res = await request(app).post(`/api/interviews/${session.id}/schedule`).set(auth()).send({ scheduledAt: 'next tuesday' });

    expect(res.status).toBe(400);
  });
});

describe('inviting a candidate again', () => {
  it('keeps the earlier invitation events instead of starting the history over', async () => {
    const session = await prisma.interviewSession.create({ data: { tenantId, candidateId, roleId, scorecardId, state: 'PROVISIONED' } });
    await request(app).post(`/api/interviews/${session.id}/invite`).set(auth());
    await prisma.interviewSession.update({ where: { id: session.id }, data: { state: 'RESCHEDULE_REQUIRED' } });

    await request(app).post(`/api/interviews/${session.id}/invite`).set(auth());

    const invitation = await prisma.invitation.findUniqueOrThrow({ where: { sessionId: session.id } });
    expect(JSON.parse(invitation.eventsJson)).toHaveLength(2);
  });
});

describe('the dashboard when a series hits its ceiling', () => {
  const claims = () => ({ userId, tenantId, role: 'admin', email: 'demo@questor.local' });

  it('says so instead of presenting a truncated average as the whole picture', async () => {
    await prisma.interviewSession.create({ data: { tenantId, candidateId, roleId, scorecardId, state: 'PROVISIONED' } });
    await prisma.interviewSession.create({ data: { tenantId, candidateId, roleId, scorecardId, state: 'PROVISIONED' } });

    const metrics = await getDashboardMetrics(claims(), { weeks: 12, recent: 5, seriesRowLimit: 2 });

    expect(metrics.truncated).toBe(true);
  });

  it('does not claim truncation under the ceiling', async () => {
    const metrics = await getDashboardMetrics(claims(), { weeks: 12, recent: 5 });

    expect(metrics.truncated).toBe(false);
  });
});
