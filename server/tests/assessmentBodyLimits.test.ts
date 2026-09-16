import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * The mutating assessment routes checked types but not sizes.
 *
 * An authenticated caller could post a hundred-thousand-character reason or ten
 * thousand competency overrides: every one of them is stored, re-read on every
 * later request, and rendered into the compliance record a regulator reads.
 * Closed body shapes are also declared closed, so a typo'd field name fails
 * loudly instead of being silently dropped — a reviewer whose "comments" went
 * nowhere still believes they filed them.
 */

const app = createApp();

const OVERSIZED = 'a'.repeat(20_001);

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

function many<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

describe('recording a blind verdict', () => {
  it('refuses more competency levels than a scorecard could hold', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/blind-verdict`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        disposition: 'CONSIDER', reason: 'Too many levels.',
        competencyLevels: many(41, (i) => ({ competencyId: `c${i}`, level: 3 })),
      });

    expect(res.status).toBe(400);
  });

  it('refuses an unbounded reason', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/blind-verdict`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'CONSIDER', reason: OVERSIZED, competencyLevels: [] });

    expect(res.status).toBe(400);
  });

  it('refuses a field it does not recognise, rather than dropping it', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/blind-verdict`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'CONSIDER', reason: 'Solid enough.', commments: 'note the typo' });

    expect(res.status).toBe(400);
  });
});

describe('recording a human review', () => {
  it('refuses more overrides than a scorecard could hold', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        disposition: 'CONSIDER', reason: 'Too many overrides.',
        overrides: many(41, (i) => ({ competencyId: `c${i}`, from: 2, to: 3, reason: 'Adjusted.' })),
      });

    expect(res.status).toBe(400);
  });

  it('refuses unbounded comments', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'CONSIDER', reason: 'Fine.', comments: OVERSIZED });

    expect(res.status).toBe(400);
  });

  it('refuses an unbounded reason inside an override', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        disposition: 'CONSIDER', reason: 'Fine.',
        overrides: [{ competencyId: 'sql', from: 2, to: 3, reason: OVERSIZED }],
      });

    expect(res.status).toBe(400);
  });

  it('still accepts an ordinary review', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'CONSIDER', reason: 'Want a second panel on leadership scope.', overrides: [] });

    expect(res.status).toBe(201);
  });
});

describe('the other closed bodies', () => {
  it('bounds the reason given for skipping a blind review', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/skip-blind-review`)
      .set('Authorization', `Bearer ${token}`).send({ reason: OVERSIZED });

    expect(res.status).toBe(400);
  });

  it('refuses an export body carrying a field it does not recognise', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/export`)
      .set('Authorization', `Bearer ${token}`).send({ externalCandidateID: 'gh-4821' });

    expect(res.status).toBe(400);
  });

  it('refuses a feedback draft body carrying an unknown field', async () => {
    const { assessmentId, token } = await signedIn();

    const res = await request(app).post(`/api/assessments/${assessmentId}/feedback/draft`)
      .set('Authorization', `Bearer ${token}`)
      .send({ draftText: 'Thank you for speaking with us today.', sendNow: true });

    expect(res.status).toBe(400);
  });
});
