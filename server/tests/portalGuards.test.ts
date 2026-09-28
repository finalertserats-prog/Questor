import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

const app = createApp();

type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;

beforeEach(async () => {
  await wipe();
  demo = await createDemoData();
});

describe('accepting an invitation', () => {
  it('reports the state the interview is actually in when it was already past accepting', async () => {
    await prisma.interviewSession.update({ where: { id: demo.sessionId }, data: { state: 'MANUAL_HANDOFF' } });

    const res = await request(app).post(`/api/portal/${demo.token}/accept`).send({});

    expect(res.body.state).toBe('MANUAL_HANDOFF');
  });

  it('reports ACCEPTED when this request accepted it', async () => {
    await prisma.interviewSession.update({ where: { id: demo.sessionId }, data: { state: 'INVITED' } });

    const res = await request(app).post(`/api/portal/${demo.token}/accept`).send({});

    expect(res.body.state).toBe('ACCEPTED');
  });
});

describe('an accommodation request', () => {
  it('refuses one longer than a person could be expected to read', async () => {
    const res = await request(app).post(`/api/portal/${demo.token}/consent`)
      .send({ recordingConsent: false, accepted: true, accommodationRequest: 'x'.repeat(2001) });

    expect(res.status).toBe(400);
  });

  it('accepts one at the limit', async () => {
    const res = await request(app).post(`/api/portal/${demo.token}/consent`)
      .send({ recordingConsent: false, accepted: true, accommodationRequest: 'x'.repeat(2000) });

    expect(res.status).toBe(200);
  });
});
