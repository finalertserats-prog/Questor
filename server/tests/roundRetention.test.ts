import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { retentionDays, runRetentionSweep } from '../src/services/dataRights.js';

/**
 * Notes recorded for human interview rounds are candidate personal data. They
 * expire with the same retention window as interview sessions — counted from
 * when the round was completed — even when the candidate still has other data
 * that is lawfully kept, and never while the candidate is under legal hold.
 */

const app = createApp();
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTES = 'Walked through a production incident end to end, with clear ownership and a measured outcome.';
const longAgo = () => new Date(Date.now() - (retentionDays() + 1) * DAY_MS);

async function completedGoldRound(scheduledAt: Date, completedAt?: Date) {
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
  if (completedAt) await prisma.interviewRound.update({ where: { id: roundId }, data: { completedAt } });
  return { pipelineId: id, roundId, sessionId: ids.sessionId };
}

async function notesOf(roundId: string) {
  return (await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } })).notes;
}

describe('retention of human round notes', () => {
  beforeEach(async () => { await wipe(); });

  it('clears notes from rounds completed before the retention window', async () => {
    const { roundId } = await completedGoldRound(longAgo(), longAgo());

    await runRetentionSweep(new Date());

    expect(await notesOf(roundId)).toBe('');
  });

  it('keeps notes from rounds completed inside the retention window', async () => {
    const { roundId } = await completedGoldRound(new Date(Date.now() - DAY_MS));

    await runRetentionSweep(new Date());

    expect(await notesOf(roundId)).toBe(NOTES);
  });

  it('counts the window from when the round was completed, not when it was scheduled', async () => {
    // Scheduled long ago but only completed now: the notes are new.
    const { roundId } = await completedGoldRound(longAgo());

    await runRetentionSweep(new Date());

    expect(await notesOf(roundId)).toBe(NOTES);
  });

  it('keeps notes while the candidate is under legal hold', async () => {
    const { roundId, sessionId } = await completedGoldRound(longAgo(), longAgo());
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { legalHold: true } });

    await runRetentionSweep(new Date());

    expect(await notesOf(roundId)).toBe(NOTES);
  });

  it('clears expired notes on a round that was never marked complete', async () => {
    const { roundId } = await completedGoldRound(longAgo());
    await prisma.interviewRound.update({ where: { id: roundId }, data: { status: 'SCHEDULED', completedAt: null } });

    await runRetentionSweep(new Date());

    expect(await notesOf(roundId)).toBe('');
  });

  it('audits the purge without recording the notes themselves', async () => {
    const { pipelineId } = await completedGoldRound(longAgo(), longAgo());

    await runRetentionSweep(new Date());

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'pipeline.round_notes_purged', entityId: pipelineId } });
    expect(audit.afterJson).not.toContain(NOTES);
  });
});
