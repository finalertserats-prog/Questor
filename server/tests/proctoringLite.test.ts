import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, parseJson } from '../src/db.js';
import { createDemoData, wipe, DEMO_RESUME } from '../src/seed/demoData.js';

const app = createApp();

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  expect(login.status).toBe(200);
  return { ...ids, auth: login.body.token as string };
}

describe('proctoring-lite integrity events', () => {
  beforeEach(async () => { await wipe(); });

  it('stores integrity events only when proctoring is enabled and consent has passed', async () => {
    const ids = await createDemoData();
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ proctoringEnabled: true }) } });
    await prisma.interviewSession.update({
      where: { id: ids.sessionId },
      data: { state: 'CONSENTED', consentJson: JSON.stringify({ consentedAt: new Date().toISOString(), disclosureText: 'ok' }) },
    });

    const accepted = await request(app).post(`/api/portal/${ids.token}/integrity-event`).send({ type: 'PASTE_DETECTED', detail: { source: 'keyboard' } });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ ok: true, accepted: true });
    expect(await prisma.integrityEvent.count({ where: { sessionId: ids.sessionId } })).toBe(1);

    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ proctoringEnabled: false }) } });
    const disabled = await request(app).post(`/api/portal/${ids.token}/integrity-event`).send({ type: 'TAB_BLUR' });
    expect(disabled.status).toBe(202);
    expect(disabled.body.accepted).toBe(false);
    expect(await prisma.integrityEvent.count({ where: { sessionId: ids.sessionId } })).toBe(1);

    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ proctoringEnabled: true }) } });
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'DISCLOSURE', consentJson: JSON.stringify({ disclosureText: 'not yet' }) } });
    const preConsent = await request(app).post(`/api/portal/${ids.token}/integrity-event`).send({ type: 'FOCUS_LOST' });
    expect(preConsent.status).toBe(202);
    expect(preConsent.body.accepted).toBe(false);
    expect(await prisma.integrityEvent.count({ where: { sessionId: ids.sessionId } })).toBe(1);

    const invalid = await request(app).post(`/api/portal/${ids.token}/integrity-event`).send({ type: 'CAMERA_ATTENTION' });
    expect(invalid.status).toBe(400);
  });

  it('returns a human-readable integrity summary on session detail without changing assessment fields', async () => {
    const ids = await seeded();
    const result = { recommendation: 'CONSIDER', confidence: 0.71, overallScore: 68, competencies: [], strengths: [], concerns: [] };
    const assessment = await prisma.assessmentVersion.create({
      data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', confidence: 0.71, evidenceCoverage: 0.5, resultJson: JSON.stringify(result) },
    });
    await prisma.integrityEvent.create({ data: { sessionId: ids.sessionId, type: 'TAB_BLUR', detail: '{}' } });

    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set('Authorization', `Bearer ${ids.auth}`);
    expect(res.status).toBe(200);
    expect(res.body.integrityEvents.count).toBe(1);
    expect(res.body.integrityEvents.events[0].type).toBe('TAB_BLUR');
    expect(res.body.integrityEvents.events[0]).not.toHaveProperty('detail');
    expect(res.body.assessment).toEqual({ id: assessment.id, recommendation: 'CONSIDER', result });

    const stored = await prisma.assessmentVersion.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(parseJson(stored.resultJson, {})).toEqual(result);
    expect(stored.recommendation).toBe('CONSIDER');
  });

  it('adds the browser-activity disclosure only when proctoring is enabled', async () => {
    const ids = await seeded();
    const base = 'Plain disclosure for this tenant.';

    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ disclosureText: base, proctoringEnabled: false }) } });
    const offCandidate = await request(app).post('/api/candidates').set('Authorization', `Bearer ${ids.auth}`)
      .send({ fullName: 'Off Candidate', email: 'off@example.com', roleId: ids.roleId });
    await request(app).post(`/api/candidates/${offCandidate.body.candidate.id}/resume`).set('Authorization', `Bearer ${ids.auth}`).field('text', DEMO_RESUME);
    const offInterview = await request(app).post('/api/interviews').set('Authorization', `Bearer ${ids.auth}`).send({ candidateId: offCandidate.body.candidate.id, approve: true });
    expect(offInterview.status).toBe(201);
    const offSession = await prisma.interviewSession.findUniqueOrThrow({ where: { id: offInterview.body.session.id } });
    expect(parseJson<any>(offSession.consentJson, {}).disclosureText).toBe(base);

    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ disclosureText: base, proctoringEnabled: true }) } });
    const onCandidate = await request(app).post('/api/candidates').set('Authorization', `Bearer ${ids.auth}`)
      .send({ fullName: 'On Candidate', email: 'on@example.com', roleId: ids.roleId });
    await request(app).post(`/api/candidates/${onCandidate.body.candidate.id}/resume`).set('Authorization', `Bearer ${ids.auth}`).field('text', DEMO_RESUME);
    const onInterview = await request(app).post('/api/interviews').set('Authorization', `Bearer ${ids.auth}`).send({ candidateId: onCandidate.body.candidate.id, approve: true });
    expect(onInterview.status).toBe(201);
    const onSession = await prisma.interviewSession.findUniqueOrThrow({ where: { id: onInterview.body.session.id } });
    expect(parseJson<any>(onSession.consentJson, {}).disclosureText).toContain('Basic browser activity');
  });
});
