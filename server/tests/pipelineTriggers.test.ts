import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { finalizeInterview } from '../src/realtime/interviewEngine.js';

/**
 * The events that move a candidate through the medallion pipeline on their
 * own: onboarding starts it, an analysed resume reaches Bronze, a scheduled
 * interview reaches Silver, an assessed interview reaches Gold. Diamond is a
 * person's explicit finalisation. Every move is forward, once, and audited.
 */

const app = createApp();
const OTHER_PASSWORD = 'other-org-correct-horse-battery';

const RESUME = 'Pat Lee\nSenior Data Engineer\n\nBuilt Airflow and dbt pipelines on Snowflake; owned incident recovery and backfills.\n\nSkills: SQL, Python, Airflow, dbt, Snowflake';

const ANSWERS = [
  'I owned the ledger pipeline end to end and made recovery idempotent after a reconciliation incident.',
  'Unmatched rows fell from two thousand a day to under thirty over the quarter.',
];

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;

async function onboardCandidate(ids: Seeded) {
  const res = await request(app).post('/api/candidates').set('Authorization', ids.auth)
    .send({ fullName: 'Pat Lee', email: 'pat.lee@example.test', roleId: ids.roleId });
  return res.body.candidate.id as string;
}

async function currentStage(ids: Seeded, candidateId: string) {
  const res = await request(app).get(`/api/pipelines?candidateId=${candidateId}`).set('Authorization', ids.auth);
  return res.body.pipelines[0] as { id: string; currentStageKey: string; status: string } | undefined;
}

function analyseResume(ids: Seeded, candidateId: string) {
  return request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', ids.auth).send({ text: RESUME });
}

function createInterview(ids: Seeded, candidateId: string) {
  return request(app).post('/api/interviews').set('Authorization', ids.auth)
    .send({ candidateId, durationMinutes: 30, language: 'en', modules: [], approve: true });
}

async function assessedInterview(ids: Seeded) {
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${ids.token}/start`).send({});
  for (const text of ANSWERS) await request(app).post(`/api/portal/${ids.token}/turn`).send({ text });
  await finalizeInterview(ids.sessionId);
}

function autoAdvances(pipelineId: string) {
  return prisma.auditEvent.findMany({ where: { action: 'pipeline.auto_advanced', entityId: pipelineId }, orderBy: { createdAt: 'asc' } });
}

describe('onboarding a candidate', () => {
  beforeEach(async () => { await wipe(); });

  it('starts their pipeline at Participation', async () => {
    const ids = await seeded();

    const candidateId = await onboardCandidate(ids);

    expect((await currentStage(ids, candidateId))?.currentStageKey).toBe('participation');
  });

  it('records the system as the actor that started the pipeline', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    const pipeline = await currentStage(ids, candidateId);

    const created = await prisma.auditEvent.findFirst({ where: { action: 'pipeline.created', entityId: pipeline?.id } });

    expect(created?.actorType).toBe('system');
  });

  it('moves them to Bronze once their resume is analysed', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);

    await analyseResume(ids, candidateId);

    expect((await currentStage(ids, candidateId))?.currentStageKey).toBe('bronze');
  });

  it('audits the automatic move with the event that caused it', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    await analyseResume(ids, candidateId);
    const pipeline = await currentStage(ids, candidateId);

    const [advance] = await autoAdvances(pipeline!.id);

    expect({ actor: advance.actorType, after: JSON.parse(advance.afterJson) })
      .toEqual({ actor: 'system', after: { stage: 'bronze', event: 'candidate.profiled', trigger: 'candidate.parsed' } });
  });

  it('does not move them twice for the same event', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    await analyseResume(ids, candidateId);

    await analyseResume(ids, candidateId);

    expect(await autoAdvances((await currentStage(ids, candidateId))!.id)).toHaveLength(1);
  });
});

describe('scheduling an interview', () => {
  beforeEach(async () => { await wipe(); });

  it('moves the candidate to Silver', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    await analyseResume(ids, candidateId);

    await createInterview(ids, candidateId);

    expect((await currentStage(ids, candidateId))?.currentStageKey).toBe('silver');
  });

  it('reaches Silver straight from Participation when no resume was analysed', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);

    await createInterview(ids, candidateId);

    expect((await currentStage(ids, candidateId))?.currentStageKey).toBe('silver');
  });

  it('lets Silver hold a second interview without moving anyone', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    await createInterview(ids, candidateId);

    const second = await createInterview(ids, candidateId);

    expect([second.status, (await currentStage(ids, candidateId))?.currentStageKey]).toEqual([201, 'silver']);
  });

  it('starts a pipeline for a candidate who had none', async () => {
    const ids = await seeded();

    await createInterview(ids, ids.candidateId);

    expect((await currentStage(ids, ids.candidateId))?.currentStageKey).toBe('silver');
  });

  it('does not touch the primary write when the pipeline plan is corrupt', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    const pipeline = await currentStage(ids, candidateId);
    await prisma.candidatePipeline.update({ where: { id: pipeline!.id }, data: { stagesJson: '{not-json' } });

    const res = await createInterview(ids, candidateId);

    expect(res.status).toBe(201);
  });
});

describe('an assessed interview', () => {
  beforeEach(async () => { await wipe(); });

  it('moves the candidate to Gold', async () => {
    const ids = await seeded();

    await assessedInterview(ids);

    expect((await currentStage(ids, ids.candidateId))?.currentStageKey).toBe('gold');
  });

  it('lets Gold hold another interview without moving back to Silver', async () => {
    const ids = await seeded();
    await assessedInterview(ids);

    await createInterview(ids, ids.candidateId);

    expect((await currentStage(ids, ids.candidateId))?.currentStageKey).toBe('gold');
  });
});

describe('finalising a candidate', () => {
  beforeEach(async () => { await wipe(); });

  async function finalize(ids: Seeded, pipelineId: string, auth = ids.auth) {
    return request(app).post(`/api/pipelines/${pipelineId}/finalize`).set('Authorization', auth).send({});
  }

  it('moves them to Diamond', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    const pipeline = await currentStage(ids, candidateId);

    const res = await finalize(ids, pipeline!.id);

    expect(res.body.pipeline.currentStageKey).toBe('diamond');
  });

  it('is recorded against the person who did it', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    const pipeline = await currentStage(ids, candidateId);
    await finalize(ids, pipeline!.id);

    const audit = await prisma.auditEvent.findFirst({ where: { action: 'pipeline.finalized', entityId: pipeline!.id } });

    expect({ actorType: audit?.actorType, actorId: audit?.actorId, after: JSON.parse(audit?.afterJson ?? '{}') })
      .toEqual({ actorType: 'user', actorId: ids.userId, after: { stage: 'diamond' } });
  });

  it('is never done by an event on its own', async () => {
    const ids = await seeded();
    await assessedInterview(ids);
    const pipeline = await currentStage(ids, ids.candidateId);

    const stages = (await autoAdvances(pipeline!.id)).map((e) => JSON.parse(e.afterJson).stage as string);

    expect(stages).not.toContain('diamond');
  });

  it('keeps them at Diamond when another interview is scheduled afterwards', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    const pipeline = await currentStage(ids, candidateId);
    await finalize(ids, pipeline!.id);

    await createInterview(ids, candidateId);

    expect((await currentStage(ids, candidateId))?.currentStageKey).toBe('diamond');
  });

  it('refuses a candidate already at Diamond', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    const pipeline = await currentStage(ids, candidateId);
    await finalize(ids, pipeline!.id);

    const again = await finalize(ids, pipeline!.id);

    expect(again.status).toBe(409);
  });

  it('refuses a pipeline that already has a decision', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    const pipeline = await currentStage(ids, candidateId);
    await request(app).post(`/api/pipelines/${pipeline!.id}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'REJECTED', reason: 'Not enough evidence on the core competency.' });

    const res = await finalize(ids, pipeline!.id);

    expect(res.status).toBe(409);
  });

  it('is not visible to another organisation', async () => {
    const ids = await seeded();
    const candidateId = await onboardCandidate(ids);
    const pipeline = await currentStage(ids, candidateId);
    const other = await request(app).post('/api/auth/register').send({ email: 'hr@other.local', password: OTHER_PASSWORD, name: 'Other HR', tenantName: 'Other Org' });

    const res = await finalize(ids, pipeline!.id, `Bearer ${other.body.token as string}`);

    expect(res.status).toBe(404);
  });
});
