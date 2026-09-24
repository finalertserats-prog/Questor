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
  return { pipelineId: id, roundId, sessionId: ids.sessionId, candidateId: ids.candidateId };
}

/** The candidate's AI interview is past its retention window, so the sweep purges it. */
async function expireInterview(sessionId: string) {
  await prisma.interviewSession.update({ where: { id: sessionId }, data: { retainUntil: longAgo(), legalHold: false } });
}

async function candidateExists(candidateId: string) {
  return (await prisma.candidate.count({ where: { id: candidateId } })) > 0;
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

  it('keeps a candidate whose pipeline is still active after their AI interview expires', async () => {
    const { sessionId, candidateId } = await completedGoldRound(longAgo(), longAgo());
    await expireInterview(sessionId);

    await runRetentionSweep(new Date());

    expect(await candidateExists(candidateId)).toBe(true);
  });

  it('keeps a decided candidate whose latest round is inside the retention window', async () => {
    const { sessionId, candidateId, pipelineId } = await completedGoldRound(new Date(Date.now() - DAY_MS));
    await prisma.candidatePipeline.update({ where: { id: pipelineId }, data: { status: 'DECIDED', decision: 'REJECTED' } });
    await expireInterview(sessionId);

    await runRetentionSweep(new Date());

    expect(await candidateExists(candidateId)).toBe(true);
  });

  it('purges a decided candidate once their interview and every round are past the window', async () => {
    const { sessionId, candidateId, pipelineId } = await completedGoldRound(longAgo(), longAgo());
    await prisma.candidatePipeline.update({ where: { id: pipelineId }, data: { status: 'DECIDED', decision: 'REJECTED' } });
    await expireInterview(sessionId);

    await runRetentionSweep(new Date());

    expect(await candidateExists(candidateId)).toBe(false);
  });

  // A round scheduled long ago but written up TODAY holds a record written
  // today, and the window runs from when the record was written. The sweep
  // selects such a round on its scheduled date when it has no completion time,
  // so the clearing step has to check the window again against the same cutoff
  // — otherwise a record can be selected while incomplete and cleared moments
  // after the interviewer finally writes it.
  it('spares a round scheduled long ago but written up just now', async () => {
    const { roundId } = await completedGoldRound(longAgo());
    await prisma.interviewRound.update({ where: { id: roundId }, data: { completedAt: new Date() } });

    await runRetentionSweep(new Date());

    expect(await notesOf(roundId)).toBe(NOTES);
  });

  // The structured record quotes the candidate, so it is at least as much
  // personal data as the prose beside it and must go on the same timer.
  it('clears the claims and quotes along with the notes', async () => {
    const { roundId } = await completedGoldRound(longAgo(), longAgo());
    await prisma.interviewRound.update({
      where: { id: roundId },
      data: { evidenceJson: JSON.stringify([{ competencyId: 'c1', competencyName: 'Incident response', claim: 'Owned it.', quote: 'I paged myself at 2am.' }]) },
    });

    await runRetentionSweep(new Date());

    expect((await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } })).evidenceJson).toBe('[]');
  });

  // A round whose prose was cleared by an earlier sweep, before the structured
  // record existed, must still have its quotes collected now.
  it('collects a round whose prose was already cleared but whose quotes were not', async () => {
    const { roundId } = await completedGoldRound(longAgo(), longAgo());
    await prisma.interviewRound.update({
      where: { id: roundId },
      data: { notes: '', evidenceJson: JSON.stringify([{ competencyId: 'c1', competencyName: 'Incident response', claim: 'Owned it.', quote: 'I paged myself at 2am.' }]) },
    });

    await runRetentionSweep(new Date());

    expect((await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } })).evidenceJson).toBe('[]');
  });

  it('audits the purge without recording the notes themselves', async () => {
    const { pipelineId } = await completedGoldRound(longAgo(), longAgo());

    await runRetentionSweep(new Date());

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'pipeline.round_notes_purged', entityId: pipelineId } });
    expect(audit.afterJson).not.toContain(NOTES);
  });
});
