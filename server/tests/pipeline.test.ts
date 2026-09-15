import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';

/**
 * The medallion pipeline: a candidate moves through ordered stages for one
 * role — Participation, Bronze, Silver, Gold, Platinum, Diamond — and a person
 * can record a final decision at any stage.
 */

const app = createApp();
const OTHER_PASSWORD = 'other-org-correct-horse-battery';

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

async function createPipeline(ids: Awaited<ReturnType<typeof seeded>>) {
  return request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId: ids.candidateId });
}

describe('creating a pipeline', () => {
  beforeEach(async () => { await wipe(); });

  it('starts at Participation with the medallion stages in order', async () => {
    const ids = await seeded();

    const res = await createPipeline(ids);

    expect(res.status).toBe(201);
    expect(res.body.pipeline.currentStageKey).toBe('participation');
    expect(res.body.pipeline.stages.map((s: { label: string }) => s.label)).toEqual(['Participation', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']);
  });

  it('refuses a second pipeline for the same candidate and role', async () => {
    const ids = await seeded();
    await createPipeline(ids);

    const second = await createPipeline(ids);

    expect(second.status).toBe(409);
  });

  it("is not visible to another organisation", async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);
    const other = await request(app).post('/api/auth/register').send({ email: 'hr@other.local', password: OTHER_PASSWORD, name: 'Other HR', tenantName: 'Other Org' });

    const res = await request(app).get(`/api/pipelines/${created.body.pipeline.id}`).set('Authorization', `Bearer ${other.body.token}`);

    expect(res.status).toBe(404);
  });
});

describe('finding a candidate\'s pipeline', () => {
  beforeEach(async () => { await wipe(); });

  it('lists the pipeline for a candidate', async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);

    const res = await request(app).get(`/api/pipelines?candidateId=${ids.candidateId}`).set('Authorization', ids.auth);

    expect(res.body.pipelines.map((p: { id: string }) => p.id)).toEqual([created.body.pipeline.id]);
  });

  it("returns 404 for a candidate in another organisation", async () => {
    const ids = await seeded();
    await createPipeline(ids);
    const other = await request(app).post('/api/auth/register').send({ email: 'hr2@other.local', password: OTHER_PASSWORD, name: 'Other HR', tenantName: 'Other Org' });

    const res = await request(app).get(`/api/pipelines?candidateId=${ids.candidateId}`).set('Authorization', `Bearer ${other.body.token}`);

    expect(res.status).toBe(404);
  });
});

describe('moving through stages', () => {
  beforeEach(async () => { await wipe(); });

  it('advances to the next stage', async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);

    const res = await request(app).post(`/api/pipelines/${created.body.pipeline.id}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'bronze' });

    expect(res.body.pipeline.currentStageKey).toBe('bronze');
  });

  it('refuses to skip a stage', async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);

    const res = await request(app).post(`/api/pipelines/${created.body.pipeline.id}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'gold' });

    expect(res.status).toBe(409);
  });

  it('keeps its own stage plan when the role configuration changes later', async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);
    await request(app).put(`/api/roles/${ids.roleId}/pipeline-stages`).set('Authorization', ids.auth)
      .send({ stages: [{ key: 'participation', label: 'Participation', kind: 'intake' }, { key: 'silver', label: 'Silver', kind: 'ai_interview' }] });

    const res = await request(app).get(`/api/pipelines/${created.body.pipeline.id}`).set('Authorization', ids.auth);

    expect(res.body.pipeline.stages).toHaveLength(6);
  });
});

describe('deciding', () => {
  beforeEach(async () => { await wipe(); });

  it('records an approval at any stage', async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);
    const id = created.body.pipeline.id;
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'bronze' });

    const res = await request(app).post(`/api/pipelines/${id}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'APPROVED', reason: 'Strong evidence across the profile review and first round.' });

    expect(res.body.pipeline).toMatchObject({ status: 'DECIDED', decision: 'APPROVED', decidedAtStageKey: 'bronze' });
  });

  it('stops a decided pipeline from advancing', async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);
    const id = created.body.pipeline.id;
    await request(app).post(`/api/pipelines/${id}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'REJECTED', reason: 'Role requirements were not met in the evidence.' });

    const res = await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'bronze' });

    expect(res.status).toBe(409);
  });

  it('writes the decision to the audit log', async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);
    await request(app).post(`/api/pipelines/${created.body.pipeline.id}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'APPROVED', reason: 'Strong evidence across the profile review and first round.' });

    const audit = await prisma.auditEvent.findFirst({ where: { action: 'pipeline.decided', entityId: created.body.pipeline.id } });

    expect(audit).not.toBeNull();
  });

  it('keeps the free-text reason out of the audit log, which outlives candidate erasure', async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);
    const reason = 'Strong evidence across the profile review and first round.';
    await request(app).post(`/api/pipelines/${created.body.pipeline.id}/decision`).set('Authorization', ids.auth).send({ decision: 'APPROVED', reason });

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'pipeline.decided', entityId: created.body.pipeline.id } });

    expect(audit.afterJson).not.toContain(reason);
  });

  it('records the decision at the stage the pipeline is actually at when advanced concurrently', async () => {
    const ids = await seeded();
    const id = (await createPipeline(ids)).body.pipeline.id as string;

    await Promise.all([
      request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'bronze' }),
      request(app).post(`/api/pipelines/${id}/decision`).set('Authorization', ids.auth).send({ decision: 'REJECTED', reason: 'Role requirements were not met in the evidence.' }),
    ]);
    const stored = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id } });

    expect(stored.decidedAtStageKey ?? stored.currentStageKey).toBe(stored.currentStageKey);
  });
});

describe('consolidated summary', () => {
  beforeEach(async () => { await wipe(); });

  it('names the stages that have no evidence yet instead of glossing over them', async () => {
    const ids = await seeded();
    const created = await createPipeline(ids);

    const res = await request(app).get(`/api/pipelines/${created.body.pipeline.id}/summary`).set('Authorization', ids.auth);

    expect(res.body.summary.missingEvidence).toEqual(expect.arrayContaining(['Silver', 'Gold']));
  });
});

describe('who runs each stage', () => {
  beforeEach(async () => { await wipe(); });

  async function advanceTo(ids: Awaited<ReturnType<typeof seeded>>, id: string, keys: string[]) {
    for (const key of keys) {
      await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: key });
    }
  }

  it('makes Silver the only AI-conducted interview; later rounds are human-led', async () => {
    const ids = await seeded();

    const res = await createPipeline(ids);

    expect(res.body.pipeline.stages.map((s: { kind: string }) => s.kind))
      .toEqual(['intake', 'profile_review', 'ai_interview', 'human_interview', 'human_interview', 'human_interview']);
  });

  it('schedules the Silver round with the AI conducting and HR as an optional observer', async () => {
    const ids = await seeded();
    const id = (await createPipeline(ids)).body.pipeline.id;
    await advanceTo(ids, id, ['bronze', 'silver']);

    const res = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', ids.auth)
      .send({ stageKey: 'silver', scheduledAt: '2026-10-01T09:00:00.000Z', sessionId: ids.sessionId });

    expect(res.body.round).toMatchObject({ conductedBy: 'AI', aiObserver: false, hrMayObserve: true });
  });

  it('schedules a Gold round with a human conducting and the AI as silent observer', async () => {
    const ids = await seeded();
    const id = (await createPipeline(ids)).body.pipeline.id;
    await advanceTo(ids, id, ['bronze', 'silver', 'gold']);

    const res = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', ids.auth)
      .send({ stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewers: ['Hiring manager'] });

    expect(res.body.round).toMatchObject({ conductedBy: 'HUMAN', aiObserver: true });
  });

  it('refuses to schedule an interview round on a stage that is not an interview', async () => {
    const ids = await seeded();
    const id = (await createPipeline(ids)).body.pipeline.id;
    await advanceTo(ids, id, ['bronze']);

    const res = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', ids.auth)
      .send({ stageKey: 'bronze', scheduledAt: '2026-10-01T09:00:00.000Z' });

    expect(res.status).toBe(409);
  });
});

describe('completing a round', () => {
  beforeEach(async () => { await wipe(); });

  async function goldRound(ids: Awaited<ReturnType<typeof seeded>>) {
    const id = (await createPipeline(ids)).body.pipeline.id as string;
    for (const key of ['bronze', 'silver', 'gold']) {
      await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: key });
    }
    const round = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', ids.auth)
      .send({ stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewers: ['Hiring manager'] });
    return { id, roundId: round.body.round.id as string };
  }

  it('records notes that then count as evidence for the stage', async () => {
    const ids = await seeded();
    const { id, roundId } = await goldRound(ids);
    await request(app).post(`/api/pipelines/${id}/rounds/${roundId}/complete`).set('Authorization', ids.auth)
      .send({ notes: 'Walked through a production incident end to end, with clear ownership and a measured outcome.' });

    const res = await request(app).get(`/api/pipelines/${id}/summary`).set('Authorization', ids.auth);

    expect(res.body.summary.missingEvidence).not.toContain('Gold');
  });

  it('refuses to complete a round without notes', async () => {
    const ids = await seeded();
    const { id, roundId } = await goldRound(ids);

    const res = await request(app).post(`/api/pipelines/${id}/rounds/${roundId}/complete`).set('Authorization', ids.auth).send({ notes: '' });

    expect(res.status).toBe(400);
  });
});

describe('configuring stages', () => {
  beforeEach(async () => { await wipe(); });

  it('rejects stage labels containing line breaks, which could forge email text or headers', async () => {
    const ids = await seeded();

    const res = await request(app).put(`/api/roles/${ids.roleId}/pipeline-stages`).set('Authorization', ids.auth)
      .send({ stages: [{ key: 'participation', label: 'Participation', kind: 'intake' }, { key: 'gold', label: 'Gold\nBcc: attacker@example.com', kind: 'human_interview' }] });

    expect(res.status).toBe(400);
  });
});
