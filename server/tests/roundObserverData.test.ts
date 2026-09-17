import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { eraseCandidate, retentionDays, runRetentionSweep } from '../src/services/dataRights.js';
import { extractEvidenceQuotes } from '../src/services/observerQuotes.js';
import { colleagueAuth, listening, observationOf, seededObserver, sendText, SPOKEN } from './observerHelpers.js';

/**
 * Who may read an observed round, and how long it lives.
 *
 * The transcript and quotes are candidate personal data. They are visible to
 * the people entitled to that candidate and nobody else, they go with an
 * erasure, they expire with the retention window, and a legal hold keeps them.
 */

const app = createApp();
const DAY_MS = 86_400_000;
const longAgo = () => new Date(Date.now() - (retentionDays() + 1) * DAY_MS);

async function endedRound() {
  const ids = await seededObserver(app);
  const { roundId } = await listening(app, ids);
  await sendText(app, ids.auth, roundId);
  await request(app).post(`/api/observer/rounds/${roundId}/end`).set('Authorization', ids.auth).send({});
  const observation = await observationOf(roundId);
  return { ids, roundId, observationId: observation.id };
}

describe('who may read an observed round', () => {
  beforeEach(async () => { await wipe(); });

  it('shows the transcript to someone entitled to the candidate', async () => {
    const { ids, roundId } = await endedRound();

    const res = await request(app).get(`/api/observer/rounds/${roundId}`).set('Authorization', ids.auth);

    expect(res.body.observation.transcript[0].text).toBe(SPOKEN);
  });

  it('names the candidate the round belongs to, so the room can link back', async () => {
    const { ids, roundId } = await endedRound();

    const res = await request(app).get(`/api/observer/rounds/${roundId}`).set('Authorization', ids.auth);

    expect(res.body.round.candidateId).toBe(ids.candidateId);
  });

  it('is not readable from another organisation', async () => {
    const { roundId } = await endedRound();
    const other = await request(app).post('/api/auth/register')
      .send({ email: 'hr@elsewhere.local', password: 'elsewhere-correct-horse-battery', name: 'Other HR', tenantName: 'Elsewhere' });

    const res = await request(app).get(`/api/observer/rounds/${roundId}`).set('Authorization', `Bearer ${other.body.token}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('billing pipeline');
  });

  it('is not readable by a colleague who is not assigned the candidate', async () => {
    const { ids, roundId } = await endedRound();
    const colleague = await colleagueAuth(ids.tenantId);

    const res = await request(app).get(`/api/observer/rounds/${roundId}`).set('Authorization', colleague);

    expect(res.status).toBe(404);
  });

  it('cannot be controlled from another organisation', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    const other = await request(app).post('/api/auth/register')
      .send({ email: 'hr@elsewhere2.local', password: 'elsewhere-correct-horse-battery', name: 'Other HR', tenantName: 'Elsewhere 2' });

    const res = await request(app).post(`/api/observer/rounds/${roundId}/stop`).set('Authorization', `Bearer ${other.body.token}`).send({});

    expect(res.status).toBe(404);
    expect((await observationOf(roundId)).status).toBe('LISTENING');
  });

  it('frames the quotes as evidence only, with no AI judgement', async () => {
    const { ids, roundId } = await endedRound();

    const res = await request(app).get(`/api/observer/rounds/${roundId}`).set('Authorization', ids.auth);

    expect(res.body.observation.quotes.framing).toMatch(/no AI judgement/i);
  });
});

describe('extracting quotes from an ended round', () => {
  beforeEach(async () => { await wipe(); });

  it('stores only verbatim quotes even when the model also sends a score and a recommendation', async () => {
    const { observationId } = await endedRound();
    const competencyId = (await firstCompetency());
    await prisma.roundObservation.update({ where: { id: observationId }, data: { quotesStatus: 'UNAVAILABLE' } });

    await extractEvidenceQuotes(observationId, {
      enabled: () => true,
      ask: async () => ({
        recommendation: 'Strong hire',
        score: 92,
        quotes: [
          { competencyId, quote: 'wrote the postmortem myself' },
          { competencyId, quote: 'An outstanding leader who takes ownership', rating: 5 },
          { competencyId, quote: 'The candidate showed great ownership' },
        ],
      }),
    });

    const stored = (await prisma.roundObservation.findUniqueOrThrow({ where: { id: observationId } })).quotesJson;
    expect(JSON.parse(stored)).toEqual([expect.objectContaining({ competencyId, quote: 'wrote the postmortem myself' })]);
    expect(stored).not.toMatch(/hire|92|outstanding|great ownership/i);
  });

  it('reports the model as unavailable rather than inventing quotes when it fails', async () => {
    const { observationId } = await endedRound();
    await prisma.roundObservation.update({ where: { id: observationId }, data: { quotesStatus: 'PENDING' } });

    await extractEvidenceQuotes(observationId, { enabled: () => true, ask: async () => { throw new Error('model down'); } });

    const stored = await prisma.roundObservation.findUniqueOrThrow({ where: { id: observationId } });
    expect(stored.quotesStatus).toBe('UNAVAILABLE');
    expect(stored.quotesJson).toBe('[]');
  });

  it('does not rewrite quotes once they are ready', async () => {
    const { observationId } = await endedRound();
    await prisma.roundObservation.update({ where: { id: observationId }, data: { quotesStatus: 'READY', quotesJson: '[]' } });

    await extractEvidenceQuotes(observationId, {
      enabled: () => true,
      ask: async () => ({ quotes: [{ competencyId: await firstCompetency(), quote: 'wrote the postmortem myself' }] }),
    });

    expect((await prisma.roundObservation.findUniqueOrThrow({ where: { id: observationId } })).quotesJson).toBe('[]');
  });
});

async function firstCompetency(): Promise<string> {
  const scorecard = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { status: 'approved' } });
  return (JSON.parse(scorecard.profileJson) as { competencies: Array<{ id: string }> }).competencies[0].id;
}

describe('erasure', () => {
  beforeEach(async () => { await wipe(); });

  it('removes the transcript and the observation with the candidate', async () => {
    const { ids, observationId } = await endedRound();

    await eraseCandidate({ tenantId: ids.tenantId, candidateId: ids.candidateId, actorId: ids.userId, reason: 'request' });

    expect(await prisma.roundObservation.count({ where: { id: observationId } })).toBe(0);
    expect(await prisma.observationSegment.count({ where: { observationId } })).toBe(0);
  });

  it('refuses erasure while the observation is under legal hold', async () => {
    const { ids, observationId } = await endedRound();
    await prisma.roundObservation.update({ where: { id: observationId }, data: { legalHold: true } });

    await expect(eraseCandidate({ tenantId: ids.tenantId, candidateId: ids.candidateId, actorId: ids.userId, reason: 'request' }))
      .rejects.toThrow(/legal hold/i);
  });

  it('removes model call records keyed to the observation', async () => {
    const { ids, observationId } = await endedRound();
    await prisma.modelExecution.create({ data: { sessionId: `observation:${observationId}`, provider: 'x', model: 'x', function: 'observer_quotes' } });

    await eraseCandidate({ tenantId: ids.tenantId, candidateId: ids.candidateId, actorId: ids.userId, reason: 'request' });

    expect(await prisma.modelExecution.count({ where: { sessionId: `observation:${observationId}` } })).toBe(0);
  });
});

describe('retention', () => {
  beforeEach(async () => { await wipe(); });

  it('purges an observation that ended before the retention window', async () => {
    const { observationId } = await endedRound();
    await prisma.roundObservation.update({ where: { id: observationId }, data: { endedAt: longAgo() } });

    await runRetentionSweep(new Date());

    expect(await prisma.roundObservation.count({ where: { id: observationId } })).toBe(0);
  });

  it('keeps an observation that ended inside the window', async () => {
    const { observationId } = await endedRound();

    await runRetentionSweep(new Date());

    expect(await prisma.observationSegment.count({ where: { observationId } })).toBe(1);
  });

  it('keeps an expired observation under legal hold', async () => {
    const { observationId } = await endedRound();
    await prisma.roundObservation.update({ where: { id: observationId }, data: { endedAt: longAgo(), legalHold: true } });

    await runRetentionSweep(new Date());

    expect(await prisma.roundObservation.count({ where: { id: observationId } })).toBe(1);
  });

  it('keeps an expired observation while the candidate has an interview under legal hold', async () => {
    const { ids, observationId } = await endedRound();
    await prisma.roundObservation.update({ where: { id: observationId }, data: { endedAt: longAgo() } });
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { legalHold: true } });

    await runRetentionSweep(new Date());

    expect(await prisma.roundObservation.count({ where: { id: observationId } })).toBe(1);
  });

  it('does not purge a round still being observed, however old', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    await prisma.roundObservation.update({ where: { roundId }, data: { createdAt: longAgo() } });

    await runRetentionSweep(new Date());

    expect(await prisma.roundObservation.count({ where: { roundId } })).toBe(1);
  });

  it('records the purge with counts only', async () => {
    const { observationId } = await endedRound();
    await prisma.roundObservation.update({ where: { id: observationId }, data: { endedAt: longAgo() } });

    await runRetentionSweep(new Date());

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'observer.purged', entityId: observationId } });
    expect(event.afterJson).not.toContain('billing');
  });
});

describe('placing a legal hold', () => {
  beforeEach(async () => { await wipe(); });

  it('lets an admin hold an observation, and audits it', async () => {
    const { ids, observationId } = await endedRound();

    const res = await request(app).patch(`/api/observer/observations/${observationId}/retention`)
      .set('Authorization', ids.auth).send({ legalHold: true });

    expect(res.status).toBe(200);
    expect(await prisma.auditEvent.count({ where: { action: 'observer.retention_updated', entityId: observationId } })).toBe(1);
  });

  it('refuses a recruiter without the retention capability', async () => {
    const { ids, observationId } = await endedRound();
    const recruiter = await colleagueAuth(ids.tenantId, 'recruiter', 'rec@demo.local');

    const res = await request(app).patch(`/api/observer/observations/${observationId}/retention`)
      .set('Authorization', recruiter).send({ legalHold: true });

    expect(res.status).toBe(403);
  });
});
