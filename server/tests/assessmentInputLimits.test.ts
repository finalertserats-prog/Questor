import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * Two unbounded inputs on the assessment routes.
 *
 * `approvedText` is emailed verbatim to the candidate and had a floor but no
 * ceiling, so anything a reviewer could paste — or a compromised session could
 * post — went out over our domain with our branding on it.
 *
 * `externalCandidateId` was taken as a bare cast and spliced straight into the
 * ATS URL, which is the classic way a path is escaped into a different endpoint
 * of the customer's own ATS.
 */

const app = createApp();

async function signedIn() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER',
      resultJson: JSON.stringify({ recommendation: 'CONSIDER', overallScore: 71, competencies: [] }),
    },
  });
  return { assessmentId: assessment.id, token: login.body.token as string };
}

const OVERSIZED = 'a'.repeat(20_001);

describe('candidate feedback text limits', () => {
  it('refuses an approved text too long to be an email to a person', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/feedback/approve`)
      .set('Authorization', `Bearer ${token}`).send({ approvedText: OVERSIZED });

    expect(res.status).toBe(400);
  });

  it('refuses a draft of the same size', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/feedback/draft`)
      .set('Authorization', `Bearer ${token}`).send({ draftText: OVERSIZED });

    expect(res.status).toBe(400);
  });
});

describe('the external candidate id an export is pushed under', () => {
  it('refuses one shaped like a path traversal', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/export`)
      .set('Authorization', `Bearer ${token}`).send({ externalCandidateId: '../../admin/settings' });

    expect(res.status).toBe(400);
  });

  it('refuses one carrying a query string', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/export`)
      .set('Authorization', `Bearer ${token}`).send({ externalCandidateId: 'abc?admin=true' });

    expect(res.status).toBe(400);
  });

  it('accepts an ordinary ATS identifier', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/export`)
      .set('Authorization', `Bearer ${token}`).send({ externalCandidateId: 'gh-4821_b' });

    expect(res.status).toBe(200);
  });
});
