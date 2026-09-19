import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, parseJson } from '../src/db.js';
import { createDemoData, wipe, DEMO_RESUME } from '../src/seed/demoData.js';
import { interviewerIntro } from '../src/domain/interviewerModel.js';

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
      data: { state: 'CONSENTED', consentJson: JSON.stringify({ consentedAt: new Date().toISOString(), disclosureText: 'ok', monitoringDisclosed: true }) },
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
    // The tenant's text with only the interviewer's named introduction in front
    // of it — no browser-activity sentence.
    const offInterviewer = parseJson<{ name: string }>(offSession.personaJson, { name: '' }).name;
    expect(parseJson<any>(offSession.consentJson, {}).disclosureText).toBe(`${interviewerIntro(offInterviewer)} ${base}`);

    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ disclosureText: base, proctoringEnabled: true }) } });
    const onCandidate = await request(app).post('/api/candidates').set('Authorization', `Bearer ${ids.auth}`)
      .send({ fullName: 'On Candidate', email: 'on@example.com', roleId: ids.roleId });
    await request(app).post(`/api/candidates/${onCandidate.body.candidate.id}/resume`).set('Authorization', `Bearer ${ids.auth}`).field('text', DEMO_RESUME);
    const onInterview = await request(app).post('/api/interviews').set('Authorization', `Bearer ${ids.auth}`).send({ candidateId: onCandidate.body.candidate.id, approve: true });
    expect(onInterview.status).toBe(201);
    const onSession = await prisma.interviewSession.findUniqueOrThrow({ where: { id: onInterview.body.session.id } });
    expect(parseJson<any>(onSession.consentJson, {}).disclosureText).toContain('Basic browser activity');
  });

  it('records at consent time that browser monitoring was disclosed', async () => {
    const ids = await createDemoData();
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ proctoringEnabled: true }) } });
    await request(app).post(`/api/portal/${ids.token}/accept`).send({});

    const res = await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: false, accepted: true, monitoringNoticeShown: true });

    expect(res.status).toBe(200);
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    const consent = parseJson<any>(session.consentJson, {});
    expect(consent).toMatchObject({ monitoringDisclosed: true, consentVersion: 'v2' });
    expect(consent.disclosureShown).toContain('Basic browser activity');
  });

  it('ignores events for a session whose consent did not cover monitoring', async () => {
    const ids = await createDemoData();
    await request(app).post(`/api/portal/${ids.token}/accept`).send({});
    await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: false, accepted: true });
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'ASSESSING' } });
    // Monitoring switched on AFTER this candidate consented.
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ proctoringEnabled: true }) } });

    const res = await request(app).post(`/api/portal/${ids.token}/integrity-event`).send({ type: 'TAB_BLUR' });

    expect(res.body.accepted).toBe(false);
    expect(await prisma.integrityEvent.count({ where: { sessionId: ids.sessionId } })).toBe(0);
  });

  it('ignores events for a session with an accommodation request', async () => {
    const ids = await createDemoData();
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ proctoringEnabled: true }) } });
    await prisma.interviewSession.update({
      where: { id: ids.sessionId },
      data: {
        state: 'ASSESSING',
        consentJson: JSON.stringify({
          consentedAt: new Date().toISOString(), monitoringDisclosed: true,
          accommodationRequest: 'I use a screen reader and need extra time to navigate.',
        }),
      },
    });

    const res = await request(app).post(`/api/portal/${ids.token}/integrity-event`).send({ type: 'FOCUS_LOST' });

    expect(res.body.accepted).toBe(false);
    expect(await prisma.integrityEvent.count({ where: { sessionId: ids.sessionId } })).toBe(0);
  });

  it('does not record monitoring as disclosed when the notice was not on the page the candidate saw', async () => {
    const ids = await createDemoData();
    await request(app).post(`/api/portal/${ids.token}/accept`).send({});
    // The candidate loaded the portal while monitoring was off...
    const page = await request(app).get(`/api/portal/${ids.token}`);
    expect(page.body.proctoringEnabled).toBe(false);
    // ...and monitoring was switched on before they pressed consent.
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ proctoringEnabled: true }) } });

    await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: false, accepted: true, monitoringNoticeShown: page.body.proctoringEnabled });

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(parseJson<any>(session.consentJson, {}).monitoringDisclosed).toBe(false);
  });
});
