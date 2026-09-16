import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * What the interviewers wrote after a human round travels with the round.
 *
 * Questor does not host Gold/Platinum/Diamond rounds, so those notes are the
 * ONLY record of what happened in them — the candidate journey shows them
 * beside the AI assessment as the evidence a person decides on. They are also
 * candidate personal data written about a named individual, so the tests below
 * pin both halves: the people entitled to the candidate can read them, and
 * nobody else can, whether they are in another organisation or simply not
 * assigned this candidate.
 */

const app = createApp();
const NOTES = 'Walked through a production incident end to end, with clear ownership and a measured outcome.';
const OTHER_ORG_PASSWORD = 'other-org-correct-horse-battery';

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  // Signed in as the demo recruiter. The token createDemoData returns is the
  // candidate's portal token, not a console session, so it will not do here.
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

/** A pipeline advanced to Gold with one human round scheduled on it. */
async function goldRound(auth: string, candidateId: string) {
  const created = await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId });
  const pipelineId = created.body.pipeline.id as string;
  for (const toStageKey of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', auth).send({ toStageKey });
  }
  const round = await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set('Authorization', auth)
    .send({ stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewers: ['Hiring manager'] });
  return { pipelineId, roundId: round.body.round.id as string };
}

function roundsOf(body: { pipeline: { rounds: Array<{ notes: string; completedAt: string | null }> } }) {
  return body.pipeline.rounds;
}

describe('reading what a human round recorded', () => {
  beforeEach(async () => { await wipe(); });

  it('returns the notes on a completed round to someone entitled to the candidate', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids.auth, ids.candidateId);
    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`)
      .set('Authorization', ids.auth).send({ notes: NOTES });

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', ids.auth);

    expect(roundsOf(res.body)[0].notes).toBe(NOTES);
  });

  it('reports when the round was completed, not only that it was', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids.auth, ids.candidateId);
    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`)
      .set('Authorization', ids.auth).send({ notes: NOTES });

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', ids.auth);

    expect(roundsOf(res.body)[0].completedAt).not.toBeNull();
  });

  it('returns an empty note for a round nobody has completed yet', async () => {
    const ids = await seeded();
    const { pipelineId } = await goldRound(ids.auth, ids.candidateId);

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', ids.auth);

    expect(roundsOf(res.body)[0].notes).toBe('');
    expect(roundsOf(res.body)[0].completedAt).toBeNull();
  });

  it('returns an empty note once retention has cleared it, rather than the old text', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids.auth, ids.candidateId);
    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`)
      .set('Authorization', ids.auth).send({ notes: NOTES });
    // What the retention sweep does to the row (services/dataRights.ts).
    await prisma.interviewRound.update({ where: { id: roundId }, data: { notes: '' } });

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', ids.auth);

    expect(roundsOf(res.body)[0].notes).toBe('');
  });
});

describe('who may read what a human round recorded', () => {
  beforeEach(async () => { await wipe(); });

  it('is not readable from another organisation', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids.auth, ids.candidateId);
    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`)
      .set('Authorization', ids.auth).send({ notes: NOTES });
    const other = await request(app).post('/api/auth/register')
      .send({ email: 'hr@other.local', password: OTHER_ORG_PASSWORD, name: 'Other HR', tenantName: 'Other Org' });

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', `Bearer ${other.body.token}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('production incident');
  });

  it('is not readable by a colleague who is not assigned this candidate', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids.auth, ids.candidateId);
    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`)
      .set('Authorization', ids.auth).send({ notes: NOTES });
    // Same organisation, same role, no assignment to this candidate or its role.
    const colleague = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: 'unassigned@demo.local', name: 'Unassigned', passwordHash: 'x', role: 'recruiter' },
    });
    const colleagueAuth = `Bearer ${signToken({ userId: colleague.id, tenantId: ids.tenantId, role: 'recruiter', email: colleague.email })}`;

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', colleagueAuth);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('production incident');
  });

  it('is not listed to a colleague who is not assigned this candidate', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids.auth, ids.candidateId);
    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`)
      .set('Authorization', ids.auth).send({ notes: NOTES });
    const colleague = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: 'unassigned2@demo.local', name: 'Unassigned', passwordHash: 'x', role: 'recruiter' },
    });
    const colleagueAuth = `Bearer ${signToken({ userId: colleague.id, tenantId: ids.tenantId, role: 'recruiter', email: colleague.email })}`;

    const res = await request(app).get(`/api/pipelines?candidateId=${ids.candidateId}`).set('Authorization', colleagueAuth);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('production incident');
  });
});
