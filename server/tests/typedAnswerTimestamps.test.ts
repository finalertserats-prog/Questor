import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * A candidate who types instead of speaking has no recorded moment their
 * answer began, and the room sends that as null. Rejecting null meant every
 * typed answer failed with "Invalid request" and the interview could not go on.
 */

const app = createApp();
let token = '';

beforeEach(async () => {
  await wipe();
  const demo = await createDemoData();
  token = demo.token;
  await request(app).post(`/api/portal/${token}/accept`).send({});
  await request(app).post(`/api/portal/${token}/consent`).send({ recordingConsent: false, accepted: true });
  await request(app).post(`/api/portal/${token}/start`).send({});
});

const ANSWER = 'I lead the data platform team and owned the migration of our batch pipelines to streaming.';

describe('a typed answer with no known start time', () => {
  it('is accepted when the start time is null', async () => {
    const res = await request(app).post(`/api/portal/${token}/turn`).send({ text: ANSWER, startMs: null, endMs: 42_000 });

    expect(res.status).toBe(200);
  });

  it('is accepted when both times are null', async () => {
    const res = await request(app).post(`/api/portal/${token}/turn`).send({ text: ANSWER, startMs: null, endMs: null });

    expect(res.status).toBe(200);
  });

  it('still rejects an end time before the start time', async () => {
    const res = await request(app).post(`/api/portal/${token}/turn`).send({ text: ANSWER, startMs: 5_000, endMs: 1_000 });

    expect(res.status).toBe(400);
  });
});
