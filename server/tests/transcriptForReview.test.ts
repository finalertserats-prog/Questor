import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * The transcript as the review page reads it before the form: each turn
 * with the competency it was asked for and its time into the interview, and
 * the facts that place the conversation (who interviewed, when, how long).
 * Nothing the AI concluded travels with it.
 */

const app = createApp();

const RESULT = {
  recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, overallScore: 70,
  competencies: [], strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
};

async function finishedInterview() {
  const ids = await createDemoData();
  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: {
      state: 'REVIEW_READY', startedAt: new Date('2026-09-17T09:00:00Z'), completedAt: new Date('2026-09-17T09:32:00Z'),
      personaJson: JSON.stringify({ interviewerId: 'maya', name: 'Maya', tone: 'warm' }),
    },
  });
  await prisma.turn.createMany({
    data: [
      { sessionId: ids.sessionId, index: 0, speaker: 'agent', text: 'Tell me about an incident you owned.', startMs: 0, endMs: 12_000, competencyId: 'own' },
      { sessionId: ids.sessionId, index: 1, speaker: 'candidate', text: 'I led the rollback.', startMs: 12_000, endMs: 65_000, competencyId: 'own' },
      { sessionId: ids.sessionId, index: 2, speaker: 'candidate', text: '(Left the interview)', startMs: 65_000, endMs: 65_000, competencyId: 'own', metaJson: JSON.stringify({ source: 'leave_button' }) },
    ],
  });
  const assessment = await prisma.assessmentVersion.create({
    data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, resultJson: JSON.stringify(RESULT) },
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  return { ...ids, assessmentId: assessment.id, auth };
}

beforeEach(async () => { await wipe(); });

describe('the transcript for review', () => {
  it('tags each turn with the competency it was asked for', async () => {
    const ids = await finishedInterview();
    const res = await request(app).get(`/api/interviews/${ids.sessionId}/transcript`).set(ids.auth);
    expect(res.body.transcript[0]).toMatchObject({ index: 0, speaker: 'agent', competencyId: 'own', startMs: 0 });
  });

  it('marks the turn where the candidate pressed Leave', async () => {
    const ids = await finishedInterview();
    const res = await request(app).get(`/api/interviews/${ids.sessionId}/transcript`).set(ids.auth);
    expect(res.body.transcript.map((t: { source?: string }) => t.source)).toEqual([undefined, undefined, 'leave_button']);
  });

  it('says who interviewed, when, and for how long', async () => {
    const ids = await finishedInterview();
    const res = await request(app).get(`/api/interviews/${ids.sessionId}/transcript`).set(ids.auth);
    expect(res.body.session).toEqual({
      interviewer: 'Maya', startedAt: '2026-09-17T09:00:00.000Z', completedAt: '2026-09-17T09:32:00.000Z', durationMinutes: 45,
    });
  });

  it('carries nothing the AI concluded', async () => {
    const ids = await finishedInterview();
    const res = await request(app).get(`/api/interviews/${ids.sessionId}/transcript`).set(ids.auth);
    expect(Object.keys(res.body).sort()).toEqual(['integrityEvents', 'session', 'transcript']);
  });

  it('stamps the blind view transcript with the time into the interview as well', async () => {
    const ids = await finishedInterview();
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/blind`).set(ids.auth);
    expect(res.body.transcript[1].startMs).toBe(12_000);
  });

  it('places the conversation on the blind view too, so the gated page can say who and when', async () => {
    const ids = await finishedInterview();
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/blind`).set(ids.auth);
    expect(res.body.session).toMatchObject({ interviewer: 'Maya', startedAt: '2026-09-17T09:00:00.000Z', durationMinutes: 45 });
  });
});
