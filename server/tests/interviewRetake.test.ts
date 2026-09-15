import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { sweepIncompleteInterviews, INACTIVITY_MS } from '../src/services/incompleteInterviews.js';

const app = createApp();

/**
 * No-fault retake (POST /interviews/:id/retake).
 *
 * Narrow on purpose: only an interview that stopped through no fault of the
 * candidate's — INCOMPLETE or TECHNICAL_FAILURE — can be retaken, and a
 * retake is a brand-new session, never a resumption of the one it replaces.
 * See routes/interviews.ts for why: resuming in place is what /reopen is for,
 * and a general "do-over" would move the population the bias audit measures.
 */

async function asHr(ids: Awaited<ReturnType<typeof createDemoData>>) {
  const token = signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email });
  return (method: 'get' | 'post', path: string) => (request(app) as any)[method](path).set('Authorization', `Bearer ${token}`);
}

async function driveToIncomplete(ids: Awaited<ReturnType<typeof createDemoData>>) {
  await request(app).post(`/api/portal/${ids.token}/accept`).send({});
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${ids.token}/start`).send({});
  await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'I led the payments platform team for four years.' });
  const past = new Date(Date.now() - INACTIVITY_MS - 60_000);
  await prisma.turn.updateMany({ where: { sessionId: ids.sessionId }, data: { createdAt: past } });
  await sweepIncompleteInterviews();
}

describe('no-fault retake', () => {
  it('creates a brand-new linked session and closes the original', async () => {
    await wipe();
    const ids = await createDemoData();
    await driveToIncomplete(ids);
    const hr = await asHr(ids);

    const res = await hr('post', `/api/interviews/${ids.sessionId}/retake`).send({ reason: 'Network dropped mid-interview, candidate asked to try again.' });

    expect(res.status).toBe(201);
    expect(res.body.session.attemptNumber).toBe(2);
    expect(res.body.session.retakeOfSessionId).toBe(ids.sessionId);
    expect(res.body.session.state).toBe('PROVISIONED');
    expect(res.body.session.id).not.toBe(ids.sessionId);

    // Closed so it stops appearing in HR's "needs action" views; its transcript
    // and the retakes relation remain the record of what happened.
    const original = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(original.state).toBe('CLOSED');

    const retake = await prisma.interviewSession.findUniqueOrThrow({ where: { id: res.body.session.id } });
    expect(retake.retakeOfSessionId).toBe(ids.sessionId);
    expect(retake.candidateId).toBe(ids.candidateId);
    expect(await prisma.interviewPlanVersion.count({ where: { sessionId: retake.id } })).toBe(1);
  });

  it('rejects a reason shorter than 10 characters', async () => {
    await wipe();
    const ids = await createDemoData();
    await driveToIncomplete(ids);
    const hr = await asHr(ids);

    const res = await hr('post', `/api/interviews/${ids.sessionId}/retake`).send({ reason: 'too short' });
    expect(res.status).toBe(400);
  });

  it('refuses a retake from a state that is not INCOMPLETE or TECHNICAL_FAILURE', async () => {
    await wipe();
    const ids = await createDemoData();
    const hr = await asHr(ids);

    // Fresh demo session starts PROVISIONED — never touched the portal flow.
    const res = await hr('post', `/api/interviews/${ids.sessionId}/retake`).send({ reason: 'Candidate asked for another attempt.' });
    expect(res.status).toBe(409);
  });

  it('refuses a third attempt', async () => {
    await wipe();
    const ids = await createDemoData();
    await driveToIncomplete(ids);
    const hr = await asHr(ids);

    const first = await hr('post', `/api/interviews/${ids.sessionId}/retake`).send({ reason: 'Network dropped mid-interview, first retake.' });
    expect(first.status).toBe(201);
    await prisma.interviewSession.update({ where: { id: first.body.session.id }, data: { state: 'INCOMPLETE' } });

    const second = await hr('post', `/api/interviews/${first.body.session.id}/retake`).send({ reason: 'Network dropped again on the second attempt.' });
    expect(second.status).toBe(409);
  });

  it('keeps the modules of the original plan', async () => {
    await wipe();
    const ids = await createDemoData();
    await driveToIncomplete(ids);
    const planRow = await prisma.interviewPlanVersion.findUniqueOrThrow({ where: { sessionId: ids.sessionId } });
    const planJson = JSON.parse(planRow.planJson);
    await prisma.interviewPlanVersion.update({ where: { sessionId: ids.sessionId }, data: { planJson: JSON.stringify({ ...planJson, modules: ['coding'] }) } });
    const hr = await asHr(ids);

    const res = await hr('post', `/api/interviews/${ids.sessionId}/retake`).send({ reason: 'Network dropped mid-interview, candidate asked to try again.' });

    expect(res.body.plan.modules).toEqual(['coding']);
  });

  it('retakes a TECHNICAL_FAILURE session and closes it', async () => {
    await wipe();
    const ids = await createDemoData();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'TECHNICAL_FAILURE' } });
    const hr = await asHr(ids);

    const res = await hr('post', `/api/interviews/${ids.sessionId}/retake`).send({ reason: 'Browser crashed during the tech check.' });

    expect(res.status).toBe(201);
    const original = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(original.state).toBe('CLOSED');
  });

  it('creates only one retake when two requests race', async () => {
    await wipe();
    const ids = await createDemoData();
    await driveToIncomplete(ids);
    const hr = await asHr(ids);
    const reason = 'Network dropped mid-interview, candidate asked to try again.';

    const results = await Promise.all([
      hr('post', `/api/interviews/${ids.sessionId}/retake`).send({ reason }),
      hr('post', `/api/interviews/${ids.sessionId}/retake`).send({ reason }),
    ]);

    expect(results.map((r: { status: number }) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.interviewSession.count({ where: { retakeOfSessionId: ids.sessionId } })).toBe(1);
  });
});
