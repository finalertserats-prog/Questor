import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, parseJson } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { candidateFeedbackEnabledForTenant } from '../src/services/candidateFeedbackPolicy.js';

const app = createApp();

async function seededAssessment() {
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  expect(login.status).toBe(200);
  const result = {
    recommendation: 'CONSIDER',
    confidence: 0.82,
    overallScore: 74,
    competencies: [{ id: 'sql', name: 'SQL', level: 4, confidence: 0.77 }],
    strengths: ['Clear production examples'],
    concerns: [],
  };
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId,
      scorecardId: ids.scorecardId,
      recommendation: 'CONSIDER',
      confidence: 0.82,
      evidenceCoverage: 0.6,
      resultJson: JSON.stringify(result),
    },
  });
  // These tests are about the review, approval and delivery gates, so the
  // candidate has said yes. Consent itself is covered in
  // candidateFeedbackConsent.test.ts.
  await prisma.candidateFeedbackOptIn.create({
    data: { sessionId: ids.sessionId, candidateId: ids.candidateId, tenantId: ids.tenantId, choice: 'YES' },
  });
  return { ...ids, auth: login.body.token as string, assessmentId: assessment.id, result };
}

async function completeHumanReview(assessmentId: string, reviewerId: string) {
  return prisma.humanReview.create({
    data: {
      assessmentId,
      reviewerId,
      status: 'COMPLETED',
      disposition: 'CONSIDER',
      reason: 'Human review completed before candidate feedback.',
      completedAt: new Date(),
    },
  });
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('candidate feedback delivery', () => {
  beforeEach(async () => { await wipe(); });

  it('requires a completed human review before drafting candidate feedback', async () => {
    const ids = await seededAssessment();

    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/draft`).set(auth(ids.auth))
      .send({ draftText: 'Thank you for speaking with us. We appreciated the examples you shared.' });

    expect(res.status).toBe(409);
    expect(await prisma.candidateFeedbackDelivery.count({ where: { assessmentId: ids.assessmentId } })).toBe(0);
  });

  it('requires a draft before approval', async () => {
    const ids = await seededAssessment();
    await completeHumanReview(ids.assessmentId, ids.userId);

    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/approve`).set(auth(ids.auth))
      .send({ approvedText: 'Thank you for your time. The hiring team will follow up with next steps.' });

    expect(res.status).toBe(409);
  });

  it('requires approval and an enabled tenant flag before sending, defaulting disabled', async () => {
    const ids = await seededAssessment();
    await completeHumanReview(ids.assessmentId, ids.userId);
    expect(await candidateFeedbackEnabledForTenant(ids.tenantId)).toBe(false);

    const unapproved = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/send`).set(auth(ids.auth)).send({});
    expect(unapproved.status).toBe(409);

    const draft = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/draft`).set(auth(ids.auth))
      .send({ draftText: 'Thank you for the thoughtful conversation and specific project examples.' });
    expect(draft.status).toBe(201);

    const approve = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/approve`).set(auth(ids.auth))
      .send({ approvedText: 'Thank you for the thoughtful conversation and specific project examples.' });
    expect(approve.status).toBe(200);
    expect(approve.body.feedback.status).toBe('APPROVED');

    const disabled = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/send`).set(auth(ids.auth)).send({});
    expect(disabled.status).toBe(409);
    expect(disabled.body.error).toMatch(/disabled/i);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ids.tenantId }, select: { policyJson: true } });
    const policy = parseJson<Record<string, unknown>>(tenant.policyJson, {});
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ ...policy, candidateFeedbackEnabled: true }) } });

    const sent = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/send`).set(auth(ids.auth)).send({});
    expect(sent.status).toBe(200);
    expect(sent.body.feedback.status).toBe('SENT');
    expect(sent.body.feedback.sentAt).toBeTruthy();

    const audit = await prisma.auditEvent.findFirst({ where: { action: 'feedback.sent', entityId: ids.assessmentId } });
    expect(audit).not.toBeNull();
  });

  it('only exposes sent qualitative feedback in the candidate portal', async () => {
    const ids = await seededAssessment();
    await completeHumanReview(ids.assessmentId, ids.userId);

    const before = await request(app).get(`/api/portal/${ids.token}/feedback`);
    expect(before.status).toBe(404);

    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/draft`).set(auth(ids.auth))
      .send({ draftText: 'We appreciated your concrete data-platform examples and collaborative approach.' });
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/approve`).set(auth(ids.auth))
      .send({ approvedText: 'We appreciated your concrete data-platform examples and collaborative approach.' });

    const approvedOnly = await request(app).get(`/api/portal/${ids.token}/feedback`);
    expect(approvedOnly.status).toBe(404);

    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ candidateFeedbackEnabled: true }) } });
    const send = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/send`).set(auth(ids.auth)).send({});
    expect(send.status).toBe(200);

    const res = await request(app).get(`/api/portal/${ids.token}/feedback`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['approvedText', 'sentAt']);
    expect(res.body.approvedText).toBe('We appreciated your concrete data-platform examples and collaborative approach.');
    const serialized = JSON.stringify(res.body).toLowerCase();
    expect(serialized).not.toContain('score');
    expect(serialized).not.toContain('competenc');
    expect(serialized).not.toContain('confidence');
    expect(serialized).not.toContain('draft');
  });

  it('refuses to rewrite feedback that has already been sent', async () => {
    const ids = await seededAssessment();
    await completeHumanReview(ids.assessmentId, ids.userId);
    const text = 'We appreciated your concrete data-platform examples and collaborative approach.';
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/draft`).set(auth(ids.auth)).send({ draftText: text });
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/approve`).set(auth(ids.auth)).send({ approvedText: text });
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ candidateFeedbackEnabled: true }) } });
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/send`).set(auth(ids.auth)).send({});

    const rewrite = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/draft`).set(auth(ids.auth))
      .send({ draftText: 'A different message replacing what the candidate already received.' });

    expect(rewrite.status).toBe(409);
    const portal = await request(app).get(`/api/portal/${ids.token}/feedback`);
    expect(portal.body.approvedText).toBe(text);
  });

  it('says whether the candidate was actually notified when feedback is sent', async () => {
    const ids = await seededAssessment();
    await completeHumanReview(ids.assessmentId, ids.userId);
    const text = 'We appreciated your concrete data-platform examples and collaborative approach.';
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/draft`).set(auth(ids.auth)).send({ draftText: text });
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/approve`).set(auth(ids.auth)).send({ approvedText: text });
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ candidateFeedbackEnabled: true }) } });

    const sent = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/send`).set(auth(ids.auth)).send({});

    // Tests run with the console email provider, which delivers nothing — the
    // response must say so and hand HR the link rather than implying delivery.
    expect(sent.body.delivery).toMatchObject({ delivered: false, portalUrl: expect.stringContaining(`/portal/${ids.token}`) });
  });
});
