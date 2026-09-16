import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * Pressing start twice is one interview, not two openings.
 *
 * startInterview accepted a session that was already live, so a refresh, a
 * double-tap, or a socket reconnect racing the portal fallback produced a
 * second agent opening: another paid LLM call, and a transcript whose canonical
 * order now contains two greetings. The candidate sees the interviewer
 * introduce itself again mid-interview.
 */

const app = createApp();

async function consentedInterview() {
  await wipe();
  const ids = await createDemoData();
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  return ids;
}

describe('starting an interview that has already started', () => {
  it('hands back the opening turn that already exists', async () => {
    const ids = await consentedInterview();
    const first = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    const second = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(second.body.turn.turnId).toBe(first.body.turn.turnId);
  });

  it('writes no second opening into the transcript', async () => {
    const ids = await consentedInterview();
    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(await prisma.turn.count({ where: { sessionId: ids.sessionId } })).toBe(1);
  });

  it('does not announce the interview as started a second time', async () => {
    const ids = await consentedInterview();
    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    const started = await prisma.auditEvent.count({
      where: { entityId: ids.sessionId, action: 'interview.started' },
    });
    expect(started).toBe(1);
  });

  it('still reports the turn as unfinished so the candidate can answer it', async () => {
    const ids = await consentedInterview();
    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    const second = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(second.body.turn.done).toBe(false);
  });
});
