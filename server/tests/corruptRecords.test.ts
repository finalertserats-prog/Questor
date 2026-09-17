import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, CorruptRecordError } from '../src/db.js';
import { logger } from '../src/logger.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { finalizeInterview } from '../src/realtime/interviewEngine.js';
import { socketFailureLog } from '../src/realtime/socket.js';
import { prepareDraftForOptIn } from '../src/services/candidateFeedback.js';
import { getAgreementReport, BLIND_REVIEW_STATUS } from '../src/services/shadowMode.js';

/**
 * Stored JSON that can no longer be read.
 *
 * `parseJson(raw, {})` turned a damaged row into an empty object, and every
 * reader carried on: the interviewer ran with no plan and no rubric, the
 * candidate was asked to consent to a blank disclosure (and that blank was then
 * written back over the original), approval of a damaged scorecard was refused
 * as "no competencies", and a policy save replaced every safeguard with the
 * patch alone. Rows that drive scoring, consent or a decision now fail loudly;
 * rows that are only decoration keep their fallback and say so in the log.
 */

const app = createApp();
const CORRUPT = '{not-json';
const CORRUPT_MESSAGE = /stored data is corrupted/i;

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

async function corruptSession(sessionId: string, data: { consentJson?: string; personaJson?: string }) {
  await prisma.interviewSession.update({ where: { id: sessionId }, data });
}

async function corruptScorecard(scorecardId: string) {
  await prisma.roleScorecardVersion.update({ where: { id: scorecardId }, data: { profileJson: CORRUPT } });
}

describe('an interview whose stored plan or rubric is unreadable', () => {
  it('refuses to start instead of interviewing from an empty plan', async () => {
    const ids = await seeded();
    await prisma.interviewPlanVersion.update({ where: { sessionId: ids.sessionId }, data: { planJson: CORRUPT } });

    const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(res.body.error).toMatch(CORRUPT_MESSAGE);
  });

  it('leaves the session where it was when the plan is unreadable', async () => {
    const ids = await seeded();
    await prisma.interviewPlanVersion.update({ where: { sessionId: ids.sessionId }, data: { planJson: CORRUPT } });

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(session.state).toBe('ACCEPTED');
  });

  it('refuses to finalise against an unreadable rubric, naming the record', async () => {
    const ids = await seeded();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'ASSESSING' } });
    await corruptScorecard(ids.scorecardId);

    const failure = await finalizeInterview(ids.sessionId).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CorruptRecordError);
  });

  it('does not strand the session in PROCESSING when the rubric is unreadable', async () => {
    const ids = await seeded();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'ASSESSING' } });
    await corruptScorecard(ids.scorecardId);

    await finalizeInterview(ids.sessionId).catch(() => undefined);

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(session.state).toBe('ASSESSING');
  });

  it('reports an unreadable consent record as corruption, not as missing consent', async () => {
    const ids = await seeded();
    await corruptSession(ids.sessionId, { consentJson: CORRUPT });

    const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(res.status).toBe(500);
  });
});

describe('a candidate whose consent record is unreadable', () => {
  it('is not shown a blank disclosure', async () => {
    const ids = await seeded();
    await corruptSession(ids.sessionId, { consentJson: CORRUPT });

    const res = await request(app).get(`/api/portal/${ids.token}`);

    expect(res.body.error).toMatch(CORRUPT_MESSAGE);
  });

  it('cannot consent over it, so the damaged record is kept for investigation', async () => {
    const ids = await seeded();
    await corruptSession(ids.sessionId, { consentJson: CORRUPT });

    await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(session.consentJson).toBe(CORRUPT);
  });
});

describe('an unreadable interviewer persona', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(logger, 'warn'); });
  afterEach(() => { warn.mockRestore(); });

  it('still serves the portal page with the default interviewer name', async () => {
    const ids = await seeded();
    await corruptSession(ids.sessionId, { personaJson: CORRUPT });

    const res = await request(app).get(`/api/portal/${ids.token}`);

    expect(res.body.persona.name).toEqual(expect.any(String));
  });

  it('logs the record id and field, never the content', async () => {
    const ids = await seeded();
    await corruptSession(ids.sessionId, { personaJson: CORRUPT });

    await request(app).get(`/api/portal/${ids.token}`);

    expect(warn).toHaveBeenCalledWith({ model: 'InterviewSession', id: ids.sessionId, field: 'personaJson' }, expect.any(String));
  });
});

describe('recruiter routes over unreadable decision data', () => {
  it('refuses to approve a scorecard it cannot read, rather than calling it empty', async () => {
    const ids = await seeded();
    await corruptScorecard(ids.scorecardId);

    const res = await request(app).post(`/api/roles/${ids.roleId}/approve`).set('Authorization', ids.auth);

    expect(res.status).toBe(500);
  });

  it('refuses to plan an interview from an unreadable scorecard', async () => {
    const ids = await seeded();
    await corruptScorecard(ids.scorecardId);

    const res = await request(app).post('/api/interviews').set('Authorization', ids.auth)
      .send({ candidateId: ids.candidateId, durationMinutes: 45, approve: true });

    expect(res.body.error).toMatch(CORRUPT_MESSAGE);
  });

  it('creates no session when the scorecard is unreadable', async () => {
    const ids = await seeded();
    await corruptScorecard(ids.scorecardId);

    await request(app).post('/api/interviews').set('Authorization', ids.auth)
      .send({ candidateId: ids.candidateId, durationMinutes: 45, approve: true });

    expect(await prisma.interviewSession.count({ where: { candidateId: ids.candidateId } })).toBe(1);
  });

  it('refuses to compare roles against an unreadable scorecard', async () => {
    const ids = await seeded();
    await corruptScorecard(ids.scorecardId);

    const res = await request(app).get(`/api/candidates/${ids.candidateId}/profile-analysis`).set('Authorization', ids.auth);

    expect(res.status).toBe(500);
  });

  it('refuses to show an interview whose assessment result is unreadable', async () => {
    const ids = await seeded();
    await prisma.assessmentVersion.create({
      data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', resultJson: CORRUPT },
    });

    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set('Authorization', ids.auth);

    expect(res.body.error).toMatch(CORRUPT_MESSAGE);
  });

  it('does not report "no profile review yet" when the stored fit is unreadable', async () => {
    const ids = await seeded();
    const created = await request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId: ids.candidateId });
    await prisma.candidateProfileVersion.updateMany({ where: { candidateId: ids.candidateId }, data: { fitScoreJson: CORRUPT } });

    const res = await request(app).get(`/api/pipelines/${created.body.pipeline.id}/summary`).set('Authorization', ids.auth);

    expect(res.status).toBe(500);
  });

  it('still lists candidates when one stored fit is unreadable, showing it as unscored', async () => {
    const ids = await seeded();
    await prisma.candidateProfileVersion.updateMany({ where: { candidateId: ids.candidateId }, data: { fitScoreJson: CORRUPT } });

    const res = await request(app).get('/api/candidates').set('Authorization', ids.auth);

    expect(res.body.candidates.map((c: { fit: unknown }) => c.fit)).toEqual([null]);
  });

  it('refuses a policy save that would replace an unreadable policy with the patch alone', async () => {
    const ids = await seeded();
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: CORRUPT } });

    await request(app).put('/api/admin/policy').set('Authorization', ids.auth).send({ policy: { proctoringEnabled: false } });

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ids.tenantId } });
    expect(tenant.policyJson).toBe(CORRUPT);
  });
});

describe('background work over an unreadable assessment', () => {
  async function optedOutWithCorruptResult() {
    const ids = await seeded();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
    await prisma.invitation.updateMany({ where: { sessionId: ids.sessionId }, data: { status: 'consumed' } });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ids.tenantId } });
    await prisma.tenant.update({
      where: { id: ids.tenantId },
      data: { policyJson: JSON.stringify({ ...JSON.parse(tenant.policyJson) as Record<string, unknown>, candidateFeedbackEnabled: true }) },
    });
    await prisma.assessmentVersion.create({
      data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', resultJson: CORRUPT },
    });
    const optIn = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: false });
    expect(optIn.status).toBe(201);
    return ids;
  }

  it('records a failed feedback draft instead of drafting from nothing', async () => {
    const ids = await optedOutWithCorruptResult();

    await prepareDraftForOptIn(ids.sessionId);

    const optIn = await prisma.candidateFeedbackOptIn.findUniqueOrThrow({ where: { sessionId: ids.sessionId } });
    expect(optIn.draftStatus).toBe('FAILED');
  });

  it('writes no feedback draft from an unreadable assessment', async () => {
    const ids = await optedOutWithCorruptResult();

    await prepareDraftForOptIn(ids.sessionId);

    expect(await prisma.candidateFeedbackDelivery.count()).toBe(0);
  });

  async function blindVerdictAgainstCorruptResult() {
    const ids = await seeded();
    const assessment = await prisma.assessmentVersion.create({
      data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', resultJson: CORRUPT },
    });
    await prisma.humanReview.create({
      data: {
        assessmentId: assessment.id, reviewerId: ids.userId, status: BLIND_REVIEW_STATUS,
        disposition: 'CONSIDER', reason: 'Solid.', overridesJson: JSON.stringify([{ competencyId: 'sql', to: 3 }]),
      },
    });
    return ids.tenantId;
  }

  it('states that an AI result was unreadable in the agreement report', async () => {
    const tenantId = await blindVerdictAgainstCorruptResult();

    const report = await getAgreementReport(tenantId);

    expect(report.blindingBypassed?.note).toMatch(/1 AI result\(s\) could not be read/);
  });

  it('keeps the readable verdict in the agreement sample', async () => {
    const tenantId = await blindVerdictAgainstCorruptResult();

    const report = await getAgreementReport(tenantId);

    expect(report.sampleSize.blindVerdicts).toBe(1);
  });
});

describe('socket failure logging', () => {
  it('names the corrupt record without its content', () => {
    const err = new CorruptRecordError({ model: 'InterviewPlanVersion', id: 'plan-1', field: 'planJson' });

    expect(socketFailureLog(err)).toEqual({ err: err.message, model: 'InterviewPlanVersion', id: 'plan-1', field: 'planJson' });
  });

  it('keeps the plain message for any other failure', () => {
    expect(socketFailureLog(new Error('boom'))).toEqual({ err: 'boom' });
  });
});
