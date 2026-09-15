import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { retentionDays, runRetentionSweep } from '../src/services/dataRights.js';

/**
 * Notes recorded for human interview rounds are candidate personal data. They
 * expire with the same retention window as interview sessions, even when the
 * candidate still has other data that is lawfully kept.
 */

const app = createApp();
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTES = 'Walked through a production incident end to end, with clear ownership and a measured outcome.';

async function completedGoldRound(scheduledAt: Date) {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  const auth = `Bearer ${login.body.token as string}`;
  const id = (await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId: ids.candidateId })).body.pipeline.id as string;
  for (const key of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', auth).send({ toStageKey: key });
  }
  const round = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', auth)
    .send({ stageKey: 'gold', scheduledAt: scheduledAt.toISOString(), interviewers: ['Hiring manager'] });
  const roundId = round.body.round.id as string;
  await request(app).post(`/api/pipelines/${id}/rounds/${roundId}/complete`).set('Authorization', auth).send({ notes: NOTES });
  return { pipelineId: id, roundId };
}

describe('retention of human round notes', () => {
  beforeEach(async () => { await wipe(); });

  it('clears notes from completed rounds older than the retention window', async () => {
    const { roundId } = await completedGoldRound(new Date(Date.now() - (retentionDays() + 1) * DAY_MS));

    await runRetentionSweep(new Date());

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
    expect(round.notes).toBe('');
  });

  it('keeps notes from rounds still inside the retention window', async () => {
    const { roundId } = await completedGoldRound(new Date(Date.now() - DAY_MS));

    await runRetentionSweep(new Date());

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
    expect(round.notes).toBe(NOTES);
  });

  it('audits the purge without recording the notes themselves', async () => {
    const { pipelineId } = await completedGoldRound(new Date(Date.now() - (retentionDays() + 1) * DAY_MS));

    await runRetentionSweep(new Date());

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'pipeline.round_notes_purged', entityId: pipelineId } });
    expect(audit.afterJson).not.toContain(NOTES);
  });
});
