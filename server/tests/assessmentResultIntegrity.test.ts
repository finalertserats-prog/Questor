import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * An assessment whose stored result cannot be read must fail loudly.
 *
 * Every read route parsed `resultJson` with `parseJson(..., {})`, so a row that
 * was truncated, half-written or written by an older shape came back as an
 * empty object and was served with a 200. The web then rendered "NaN/100", and
 * — far worse — a reviewer could file a disposition against a screen showing no
 * evidence at all, producing a signed-off hiring decision based on nothing.
 */

const app = createApp();

const UNREADABLE = [
  ['truncated JSON', '{"recommendation":"PROCEED","overallSc'],
  ['a JSON value that is not an object', '"PROCEED"'],
  ['an object with no overall score at all', JSON.stringify({ recommendation: 'PROCEED', competencies: [] })],
  ['an overall score that is not a number', JSON.stringify({ recommendation: 'PROCEED', overallScore: 'seventy' })],
] as const;

async function seedAssessment(resultJson: string) {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  const token = login.body.token as string;
  const assessment = await prisma.assessmentVersion.create({
    data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'PROCEED', resultJson },
  });
  // The demo account can review, so blind-first would answer 409 before the
  // result is ever read. Bypassing it is the product's own escape hatch and is
  // what puts this test on the code path it is about.
  await request(app).post(`/api/assessments/${assessment.id}/skip-blind-review`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'Checking how a damaged assessment row is served.' });
  return { assessmentId: assessment.id, token };
}

describe('reading an assessment whose stored result is damaged', () => {
  for (const [shape, resultJson] of UNREADABLE) {
    it(`refuses to serve ${shape}`, async () => {
      const { assessmentId, token } = await seedAssessment(resultJson);

      const res = await request(app).get(`/api/assessments/${assessmentId}`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  }

  it('says so in plain words', async () => {
    const { assessmentId, token } = await seedAssessment(UNREADABLE[0][1]);

    const res = await request(app).get(`/api/assessments/${assessmentId}`).set('Authorization', `Bearer ${token}`);

    expect(res.body.error).toBe('This assessment could not be read.');
  });

  it('leaks no stack trace to the caller', async () => {
    const { assessmentId, token } = await seedAssessment(UNREADABLE[0][1]);

    const res = await request(app).get(`/api/assessments/${assessmentId}`).set('Authorization', `Bearer ${token}`);

    expect(JSON.stringify(res.body)).not.toMatch(/\bat .*\.ts:\d+/);
  });

  it('refuses to render a report from it', async () => {
    // Same conclusions in prose. Gating the JSON route alone would leave the
    // damaged result reachable through the document people actually forward.
    const { assessmentId, token } = await seedAssessment(UNREADABLE[0][1]);

    const res = await request(app).get(`/api/assessments/${assessmentId}/report`).set('Authorization', `Bearer ${token}`);

    expect(res.body.error).toBe('This assessment could not be read.');
  });

  it('refuses to export it to the ATS', async () => {
    const { assessmentId, token } = await seedAssessment(UNREADABLE[0][1]);

    const res = await request(app).post(`/api/assessments/${assessmentId}/export`)
      .set('Authorization', `Bearer ${token}`).send({});

    expect(res.body.error).toBe('This assessment could not be read.');
  });

  it('still serves an assessment that records no score as a deliberate null', async () => {
    // null is a real, intended value (see the SCORING_UNAVAILABLE path); only
    // an unreadable result is a fault.
    const { assessmentId, token } = await seedAssessment(JSON.stringify({
      recommendation: 'SCORING_UNAVAILABLE', overallScore: null, competencies: [],
    }));

    const res = await request(app).get(`/api/assessments/${assessmentId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});
