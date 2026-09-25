import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, parseJson } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';

/**
 * HR as silent observer of the AI interview (the Silver round).
 *
 * Observation must be disclosed to the candidate before they consent. HR sees
 * the live transcript; they cannot speak. Every observer is recorded.
 */

const app = createApp();
const OTHER_PASSWORD = 'observer-other-correct-horse';

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

/** Pipeline advanced to Silver with an AI round scheduled on the demo interview session. */
async function silverRound(ids: Awaited<ReturnType<typeof seeded>>, { consented = false } = {}) {
  if (!consented) {
    // The seeded demo interview is already consented; model a freshly invited one.
    await prisma.interviewSession.update({
      where: { id: ids.sessionId },
      // Consent is refused unless the disclosure names the AI interviewer.
      data: { state: 'INVITED', consentJson: JSON.stringify({ disclosureText: 'Your interviewer today is Maya, an AI interviewer from Questor. A person on the hiring team reviews the interview.' }) },
    });
  }
  const created = await request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId: ids.candidateId });
  const id = created.body.pipeline.id as string;
  for (const key of ['bronze', 'silver']) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: key });
  }
  return request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', ids.auth)
    .send({ stageKey: 'silver', scheduledAt: '2026-10-01T09:00:00.000Z', sessionId: ids.sessionId });
}

async function candidateConsents(token: string, observerNoticeShown: boolean) {
  await request(app).post(`/api/portal/${token}/accept`).send({});
  await request(app).post(`/api/portal/${token}/consent`).send({ recordingConsent: false, accepted: true, observerNoticeShown });
}

/** The interview begins: the AI's opening turn reads the disclosure aloud. */
async function interviewStarts(token: string) {
  await request(app).post(`/api/portal/${token}/start`).send({});
}

/** The candidate answers through their own portal, after hearing the opening disclosure. */
async function candidateAnswers(token: string) {
  await request(app).post(`/api/portal/${token}/turn`).send({ text: 'Yes, I can hear you clearly and I am ready to begin.' });
}

describe('disclosing that HR may observe', () => {
  beforeEach(async () => { await wipe(); });

  it('adds the observer notice to the candidate disclosure when a Silver round is scheduled before consent', async () => {
    const ids = await seeded();

    await silverRound(ids);

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(parseJson<{ disclosureText?: string }>(session.consentJson, {}).disclosureText).toContain('may observe this interview');
  });

  it('records in the audit log that the observer notice was added to the candidate disclosure', async () => {
    const ids = await seeded();

    await silverRound(ids);

    const audit = await prisma.auditEvent.findFirst({ where: { action: 'interview.observer_notice_added', entityId: ids.sessionId, actorId: ids.userId } });
    expect(audit).not.toBeNull();
  });

  it('does not add the notice to an interview the candidate has already consented to', async () => {
    const ids = await seeded();

    await silverRound(ids, { consented: true });

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(parseJson<{ disclosureText?: string }>(session.consentJson, {}).disclosureText ?? '').not.toContain('may observe this interview');
  });

  it('tells the candidate portal that the notice is shown', async () => {
    const ids = await seeded();
    await silverRound(ids);

    const page = await request(app).get(`/api/portal/${ids.token}`);

    expect(page.body.observerNotice).toBe(true);
  });
});

describe('watching the interview live', () => {
  beforeEach(async () => { await wipe(); });

  it('lets HR read the live transcript once the candidate has heard the notice and answered', async () => {
    const ids = await seeded();
    await silverRound(ids);
    await candidateConsents(ids.token, true);
    await interviewStarts(ids.token);
    await candidateAnswers(ids.token);

    const res = await request(app).get(`/api/interviews/${ids.sessionId}/observe`).set('Authorization', ids.auth);

    expect(res.status).toBe(200);
  });

  it('refuses observation until the candidate has answered after hearing the notice', async () => {
    const ids = await seeded();
    await silverRound(ids);
    await candidateConsents(ids.token, true);
    await interviewStarts(ids.token);

    const res = await request(app).get(`/api/interviews/${ids.sessionId}/observe`).set('Authorization', ids.auth);

    expect(res.status).toBe(409);
  });

  it('refuses observation of an interview a staff member started and answered themselves', async () => {
    const ids = await seeded();
    await silverRound(ids);
    await candidateConsents(ids.token, true);
    await request(app).post(`/api/interviews/${ids.sessionId}/start`).set('Authorization', ids.auth).send({});
    await request(app).post(`/api/interviews/${ids.sessionId}/turn`).set('Authorization', ids.auth).send({ text: 'Yes, I can hear you clearly and I am ready to begin.' });

    const res = await request(app).get(`/api/interviews/${ids.sessionId}/observe`).set('Authorization', ids.auth);

    expect(res.status).toBe(409);
  });

  it('refuses observation until the AI has spoken the observer notice, whatever the consent flag says', async () => {
    const ids = await seeded();
    await silverRound(ids);
    // A consent flag alone is client-supplied and could be sent by anyone holding the portal link.
    await candidateConsents(ids.token, true);

    const res = await request(app).get(`/api/interviews/${ids.sessionId}/observe`).set('Authorization', ids.auth);

    expect(res.status).toBe(409);
  });

  it('refuses when the candidate consented without seeing the observer notice', async () => {
    const ids = await seeded();
    await silverRound(ids);
    await candidateConsents(ids.token, false);

    const res = await request(app).get(`/api/interviews/${ids.sessionId}/observe`).set('Authorization', ids.auth);

    expect(res.status).toBe(409);
  });

  it('records who observed in the audit log', async () => {
    const ids = await seeded();
    await silverRound(ids);
    await candidateConsents(ids.token, true);
    await interviewStarts(ids.token);
    await candidateAnswers(ids.token);
    await request(app).get(`/api/interviews/${ids.sessionId}/observe`).set('Authorization', ids.auth);

    const audit = await prisma.auditEvent.findFirst({ where: { action: 'interview.observed', entityId: ids.sessionId, actorId: ids.userId } });

    expect(audit).not.toBeNull();
  });

  it('refuses the full transcript of a live interview the candidate was not told may be observed', async () => {
    const ids = await seeded();
    await silverRound(ids);
    await candidateConsents(ids.token, false);
    await interviewStarts(ids.token);
    await candidateAnswers(ids.token);

    const res = await request(app).get(`/api/interviews/${ids.sessionId}/transcript`).set('Authorization', ids.auth);

    expect(res.status).toBe(409);
  });

  it('serves the full transcript once the interview has ended', async () => {
    const ids = await seeded();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY' } });

    const res = await request(app).get(`/api/interviews/${ids.sessionId}/transcript`).set('Authorization', ids.auth);

    expect(res.status).toBe(200);
  });

  it('is not available to another organisation', async () => {
    const ids = await seeded();
    await silverRound(ids);
    await candidateConsents(ids.token, true);
    const other = await request(app).post('/api/auth/register').send({ email: 'observer@other.local', password: OTHER_PASSWORD, name: 'Other HR', tenantName: 'Other Org' });

    const res = await request(app).get(`/api/interviews/${ids.sessionId}/observe`).set('Authorization', `Bearer ${other.body.token}`);

    expect(res.status).toBe(404);
  });
});
