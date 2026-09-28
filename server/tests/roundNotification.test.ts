import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';

/**
 * When HR schedules an interview round, they get the link they need: the live
 * observe page for the AI interview, the candidate's page for a human round.
 * Whether the email actually went out is reported, never assumed.
 */

const app = createApp();

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

async function advanceTo(ids: Awaited<ReturnType<typeof seeded>>, keys: string[]) {
  const id = (await request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId: ids.candidateId })).body.pipeline.id as string;
  for (const key of keys) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: key });
  }
  return id;
}

describe('notifying HR when a round is scheduled', () => {
  beforeEach(async () => { await wipe(); });

  it('sends the observe link for an AI interview round', async () => {
    const ids = await seeded();
    const id = await advanceTo(ids, ['bronze', 'silver']);

    const res = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', ids.auth)
      .send({ stageKey: 'silver', scheduledAt: '2026-10-01T09:00:00.000Z', sessionId: ids.sessionId });

    expect(res.body.notification.link).toContain(`/interviews/${ids.sessionId}/observe`);
  });

  it("sends the candidate's page for a human round", async () => {
    const ids = await seeded();
    const id = await advanceTo(ids, ['bronze', 'silver', 'gold']);

    const res = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', ids.auth)
      .send({ stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewers: ['Hiring manager'] });

    expect(res.body.notification.link).toContain(`/candidates/${ids.candidateId}`);
  });

  it('says plainly when the email was not delivered', async () => {
    const ids = await seeded();
    const id = await advanceTo(ids, ['bronze', 'silver', 'gold']);

    // Tests run with the console email provider, which delivers nothing.
    const res = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', ids.auth)
      .send({ stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z' });

    expect(res.body.notification).toMatchObject({ delivered: false });
  });
});
