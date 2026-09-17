import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import {
  SPOKEN, colleagueAuth, humanRound, interviewerConsents, listening, observationOf, seededObserver, sendText,
} from './observerHelpers.js';

/**
 * The AI observer on a human interview round (task #10).
 *
 * Nothing is captured until BOTH the interviewer and the candidate have agreed,
 * each for themselves, and either can decline or stop it at any time. A stop
 * takes effect at once: whatever arrives afterwards is refused, not stored.
 */

const app = createApp();

describe('consent before capture', () => {
  beforeEach(async () => { await wipe(); });

  it('refuses a transcript segment before anyone has consented', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);

    const res = await sendText(app, ids.auth, roundId);

    expect(res.status).toBe(409);
  });

  it('refuses a transcript segment when only the interviewer has consented', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);
    await interviewerConsents(app, ids.auth, roundId);

    const res = await sendText(app, ids.auth, roundId);

    expect(res.status).toBe(409);
  });

  it('stores nothing when only the interviewer has consented', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);
    await interviewerConsents(app, ids.auth, roundId);
    await sendText(app, ids.auth, roundId);

    expect((await observationOf(roundId)).segments).toHaveLength(0);
  });

  it('will not start listening until the candidate has consented', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);
    await interviewerConsents(app, ids.auth, roundId);

    const res = await request(app).post(`/api/observer/rounds/${roundId}/start`).set('Authorization', ids.auth).send({});

    expect(res.status).toBe(409);
  });

  it('refuses a segment after both consented but before listening started', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);
    const token = await interviewerConsents(app, ids.auth, roundId);
    await request(app).post(`/api/observer-consent/${token}/consent`).send({});

    const res = await sendText(app, ids.auth, roundId);

    expect(res.status).toBe(409);
  });

  it('captures once both have consented and listening has started', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);

    const res = await sendText(app, ids.auth, roundId);

    expect(res.status).toBe(201);
    expect((await observationOf(roundId)).segments[0].text).toBe(SPOKEN);
  });

  it('records who consented and when, for both parties', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    const observation = await observationOf(roundId);

    const events = await prisma.auditEvent.findMany({ where: { entityId: observation.id, action: { startsWith: 'observer.' } } });

    expect(events.find((e) => e.action === 'observer.interviewer_consented')?.actorId).toBe(ids.userId);
    expect(events.find((e) => e.action === 'observer.candidate_consented')?.actorId).toBe('candidate');
    expect(observation.interviewerConsentAt).not.toBeNull();
    expect(observation.candidateConsentAt).not.toBeNull();
  });

  it('never gives the candidate link to the page as anything but a link', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);

    const res = await request(app).post(`/api/observer/rounds/${roundId}/consent`).set('Authorization', ids.auth).send({});

    expect(res.status).toBe(201);
    expect(res.body.observation.candidateLink).toMatch(/\/observer-consent\/[A-Za-z0-9_-]{16,}$/);
  });

  it('refuses an observer on a round the AI conducts', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);
    await prisma.interviewRound.update({ where: { id: roundId }, data: { conductedBy: 'AI', aiObserver: false } });

    const res = await request(app).post(`/api/observer/rounds/${roundId}/consent`).set('Authorization', ids.auth).send({});

    expect(res.status).toBe(409);
  });

  it('only lets the interviewer who consented send audio', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    const otherAdmin = await colleagueAuth(ids.tenantId, 'admin', 'other-admin@demo.local');

    const res = await sendText(app, otherAdmin, roundId);

    expect(res.status).toBe(403);
  });
});

describe('declining', () => {
  beforeEach(async () => { await wipe(); });

  it('lets the candidate decline, and then nothing can start', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);
    const token = await interviewerConsents(app, ids.auth, roundId);
    await request(app).post(`/api/observer-consent/${token}/decline`).send({});

    const start = await request(app).post(`/api/observer/rounds/${roundId}/start`).set('Authorization', ids.auth).send({});

    expect(start.status).toBe(409);
    expect((await observationOf(roundId)).status).toBe('DECLINED');
  });

  it('lets the interviewer decline, which records the decision and issues no candidate link', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);

    const res = await request(app).post(`/api/observer/rounds/${roundId}/decline`).set('Authorization', ids.auth).send({});

    expect(res.body.observation.status).toBe('DECLINED');
    expect(res.body.observation.candidateLink).toBeNull();
  });

  it('leaves the round itself untouched when the observer is declined', async () => {
    const ids = await seededObserver(app);
    const { pipelineId, roundId } = await humanRound(app, ids);
    await request(app).post(`/api/observer/rounds/${roundId}/decline`).set('Authorization', ids.auth).send({});

    const done = await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`).set('Authorization', ids.auth)
      .send({ notes: 'The round ran normally without the observer and these are the notes.' });

    expect(done.status).toBe(200);
  });

  it('audits a candidate decline', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);
    const token = await interviewerConsents(app, ids.auth, roundId);
    await request(app).post(`/api/observer-consent/${token}/decline`).send({});

    const count = await prisma.auditEvent.count({ where: { action: 'observer.candidate_declined' } });

    expect(count).toBe(1);
  });
});

describe('stopping mid-round', () => {
  beforeEach(async () => { await wipe(); });

  it('refuses audio the moment the interviewer stops', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    await sendText(app, ids.auth, roundId);
    await request(app).post(`/api/observer/rounds/${roundId}/stop`).set('Authorization', ids.auth).send({});

    const res = await sendText(app, ids.auth, roundId, 'Anything said after the stop must not be kept.', 30_000);

    expect(res.status).toBe(409);
    expect((await observationOf(roundId)).segments).toHaveLength(1);
  });

  it('lets the candidate stop it from their own link', async () => {
    const ids = await seededObserver(app);
    const { roundId, token } = await listening(app, ids);

    await request(app).post(`/api/observer-consent/${token}/stop`).send({});

    const observation = await observationOf(roundId);
    expect(observation.status).toBe('STOPPED');
    expect(observation.stoppedBy).toBe('candidate');
  });

  it('refuses audio after the candidate stops', async () => {
    const ids = await seededObserver(app);
    const { roundId, token } = await listening(app, ids);
    await request(app).post(`/api/observer-consent/${token}/stop`).send({});

    const res = await sendText(app, ids.auth, roundId);

    expect(res.status).toBe(409);
  });

  it('records the stop with who and when', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    await request(app).post(`/api/observer/rounds/${roundId}/stop`).set('Authorization', ids.auth).send({});

    const event = await prisma.auditEvent.findFirst({ where: { action: 'observer.stopped' } });

    expect(event?.actorId).toBe(ids.userId);
    expect((await observationOf(roundId)).stoppedAt).not.toBeNull();
  });

  it('cannot be restarted once stopped', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    await request(app).post(`/api/observer/rounds/${roundId}/stop`).set('Authorization', ids.auth).send({});

    const res = await request(app).post(`/api/observer/rounds/${roundId}/start`).set('Authorization', ids.auth).send({});

    expect(res.status).toBe(409);
  });

  it('tells the interviewer page that the candidate stopped it', async () => {
    const ids = await seededObserver(app);
    const { roundId, token } = await listening(app, ids);
    await request(app).post(`/api/observer-consent/${token}/stop`).send({});

    const res = await request(app).get(`/api/observer/rounds/${roundId}`).set('Authorization', ids.auth);

    expect(res.body.observation.stoppedBy).toBe('candidate');
  });
});

describe('ending the round', () => {
  beforeEach(async () => { await wipe(); });

  it('makes the transcript read-only once the round ends', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    await sendText(app, ids.auth, roundId);
    await request(app).post(`/api/observer/rounds/${roundId}/end`).set('Authorization', ids.auth).send({});

    const late = await sendText(app, ids.auth, roundId, 'A late addition should never be accepted here.', 60_000);
    const view = await request(app).get(`/api/observer/rounds/${roundId}`).set('Authorization', ids.auth);

    expect(late.status).toBe(409);
    expect(view.body.observation.readOnly).toBe(true);
    expect(view.body.observation.transcript).toHaveLength(1);
  });

  it('says plainly that no quotes were produced when no model is configured', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    await sendText(app, ids.auth, roundId);

    await request(app).post(`/api/observer/rounds/${roundId}/end`).set('Authorization', ids.auth).send({});

    const observation = await observationOf(roundId);
    expect(observation.quotesStatus).toBe('UNAVAILABLE');
    expect(observation.quotesJson).toBe('[]');
  });

  it('ends the observer when the round is completed from the pipeline', async () => {
    const ids = await seededObserver(app);
    const { pipelineId, roundId } = await listening(app, ids);

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`).set('Authorization', ids.auth)
      .send({ notes: 'Completed from the pipeline while the observer was still listening.' });

    expect((await observationOf(roundId)).status).toBe('ENDED');
  });

  it('refuses consent on a round that is already complete', async () => {
    const ids = await seededObserver(app);
    const { pipelineId, roundId } = await humanRound(app, ids);
    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`).set('Authorization', ids.auth)
      .send({ notes: 'The round finished before anyone asked for an observer.' });

    const res = await request(app).post(`/api/observer/rounds/${roundId}/consent`).set('Authorization', ids.auth).send({});

    expect(res.status).toBe(409);
  });
});

describe('the candidate consent link', () => {
  beforeEach(async () => { await wipe(); });

  it('explains what the observer does and does not do', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);
    const token = await interviewerConsents(app, ids.auth, roundId);

    const res = await request(app).get(`/api/observer-consent/${token}`);

    expect(res.body.notice).toMatch(/will not score/i);
  });

  it('does not reveal the candidate name or the transcript', async () => {
    const ids = await seededObserver(app);
    const { roundId, token } = await listening(app, ids);
    await sendText(app, ids.auth, roundId);

    const res = await request(app).get(`/api/observer-consent/${token}`);

    expect(JSON.stringify(res.body)).not.toMatch(/Priya|billing pipeline/);
  });

  it('answers 404 for a link that does not exist', async () => {
    const res = await request(app).get('/api/observer-consent/AAAAAAAAAAAAAAAAAAAAAAAA');

    expect(res.status).toBe(404);
  });

  it('cannot consent after declining', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await humanRound(app, ids);
    const token = await interviewerConsents(app, ids.auth, roundId);
    await request(app).post(`/api/observer-consent/${token}/decline`).send({});

    const res = await request(app).post(`/api/observer-consent/${token}/consent`).send({});

    expect(res.status).toBe(409);
  });
});
