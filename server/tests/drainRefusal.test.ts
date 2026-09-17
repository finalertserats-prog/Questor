import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { markDraining, _resetDraining } from '../src/services/drainState.js';
import { countLiveSessions, inFlightRequests, holdCandidateSocket, _resetLiveSessions, DRAIN_IDLE_MS } from '../src/realtime/liveSessions.js';
import { drainRefusal } from '../src/realtime/socket.js';

/**
 * What a draining process does and does not accept.
 *
 * The point of the drain is that the person already talking to the interviewer
 * finishes, so their turns keep being served. The person who has not started
 * yet is told, in words they can act on, to come back in a few minutes —
 * instead of starting an interview this process is about to abandon.
 */

const app = createApp();

async function consentedInterview() {
  const ids = await createDemoData();
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  return ids;
}

beforeEach(async () => {
  _resetDraining();
  _resetLiveSessions();
  await wipe();
});

afterEach(() => {
  _resetDraining();
});

describe('the health check while draining', () => {
  it('reports not draining in normal running', async () => {
    const res = await request(app).get('/api/health');

    expect(res.body.draining).toBe(false);
  });

  it('reports draining once shutdown has begun', async () => {
    markDraining();

    const res = await request(app).get('/api/health');

    expect(res.body.draining).toBe(true);
  });

  it('keeps answering ok so the process is not mistaken for a crashed one', async () => {
    markDraining();

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
  });
});

describe('starting an interview while draining', () => {
  it('refuses a new start with a retryable 503', async () => {
    const ids = await consentedInterview();
    markDraining();

    const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(res.status).toBe(503);
  });

  it('tells the client when to try again', async () => {
    const ids = await consentedInterview();
    markDraining();

    const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('tells the candidate in plain words that it is a short update, not a failure', async () => {
    const ids = await consentedInterview();
    markDraining();

    const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(res.body.error).toMatch(/update/i);
  });

  it('leaves the session where it was so the candidate can start later', async () => {
    const ids = await consentedInterview();
    const before = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    markDraining();

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    const after = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(after.state).toBe(before.state);
  });

  it('refuses a recruiter-driven start too', async () => {
    const ids = await consentedInterview();
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
    markDraining();

    const res = await request(app).post(`/api/interviews/${ids.sessionId}/start`)
      .set('Authorization', `Bearer ${login.body.token}`).send({});

    expect(res.status).toBe(503);
  });

  it('still hands a candidate already in the interview their opening turn', async () => {
    const ids = await consentedInterview();
    await request(app).post(`/api/portal/${ids.token}/start`).send({});
    markDraining();

    const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(res.status).toBe(200);
  });

  it('keeps accepting answers from a candidate already in the interview', async () => {
    const ids = await consentedInterview();
    await request(app).post(`/api/portal/${ids.token}/start`).send({});
    markDraining();

    const res = await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'I built a streaming pipeline in Kafka.' });

    expect(res.status).toBe(200);
  });
});

describe('the socket while draining', () => {
  it('refuses to join a session that has not started', () => {
    expect(drainRefusal(true, 'candidate', 'INVITED')).not.toBeNull();
  });

  it('lets a candidate back into an interview already under way', () => {
    expect(drainRefusal(true, 'candidate', 'ASSESSING')).toBeNull();
  });

  it('lets staff observe while draining, which keeps nothing alive', () => {
    expect(drainRefusal(true, 'user', 'INVITED')).toBeNull();
  });

  it('refuses nothing when not draining', () => {
    expect(drainRefusal(false, 'candidate', 'INVITED')).toBeNull();
  });
});

describe('counting interviews this process is still serving', () => {
  it('counts a session whose candidate has just started', async () => {
    const ids = await consentedInterview();
    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(await countLiveSessions()).toBe(1);
  });

  it('stops counting a session once it has ended', async () => {
    const ids = await consentedInterview();
    await request(app).post(`/api/portal/${ids.token}/start`).send({});
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'CANDIDATE_WITHDREW' } });

    expect(await countLiveSessions()).toBe(0);
  });

  it('stops counting a candidate who has gone quiet past the idle window', async () => {
    const ids = await consentedInterview();
    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(await countLiveSessions(Date.now() + DRAIN_IDLE_MS + 1)).toBe(0);
  });

  it('does not wait for a candidate who has the room open but has not started', async () => {
    const ids = await consentedInterview();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'CONSENTED' } });
    holdCandidateSocket(ids.sessionId);

    expect(await countLiveSessions()).toBe(0);
  });

  it('waits for a candidate holding a socket to an interview under way', async () => {
    const ids = await consentedInterview();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'ASSESSING' } });
    holdCandidateSocket(ids.sessionId);

    expect(await countLiveSessions()).toBe(1);
  });

  it('counts nothing when no interview has been touched', async () => {
    await consentedInterview();

    expect(await countLiveSessions()).toBe(0);
  });

  it('has no request in flight once a response has been sent', async () => {
    await request(app).get('/api/health');

    expect(inFlightRequests()).toBe(0);
  });
});
