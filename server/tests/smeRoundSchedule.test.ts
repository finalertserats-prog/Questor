import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * When the expert's interview is, on the expert's own surface.
 *
 * /api/sme returned no scheduled time anywhere — not on the worklist, not on
 * the candidate. An expert seated on a Gold round could open Questor and still
 * have no way to find out when it was, which made a lost email an
 * unrecoverable state rather than an inconvenience.
 *
 * Scoped on the seat, like everything else here: an expert sees the rounds they
 * are in the room for, and a candidate they were handed but are not seated on
 * shows them no round at all.
 */

const app = createApp();

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { tenantId: ids.tenantId, candidateId: ids.candidateId, auth: `Bearer ${login.body.token as string}` };
}

async function expert(tenantId: string, handle: string) {
  const user = await prisma.user.create({
    data: { tenantId, email: `${handle}@demo.local`, name: handle, passwordHash: 'x', role: 'sme' },
  });
  return { id: user.id, auth: `Bearer ${signToken({ userId: user.id, tenantId, role: 'sme', email: user.email })}` };
}

async function pipelineAtGold(auth: string, candidateId: string) {
  const created = await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId });
  const id = created.body.pipeline.id as string;
  for (const toStageKey of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', auth).send({ toStageKey });
  }
  return id;
}

const AT = '2026-11-05T09:00:00.000Z';

/** Assign the expert, then seat them on a round of their own. */
async function assignedAndSeated(ids: Awaited<ReturnType<typeof seeded>>, handle: string, body: Record<string, unknown> = {}) {
  const sme = await expert(ids.tenantId, handle);
  await request(app).post(`/api/candidates/${ids.candidateId}/sme`).set('Authorization', ids.auth).send({ userId: sme.id });
  const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);
  const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set('Authorization', ids.auth)
    .send({ stageKey: 'gold', scheduledAt: AT, interviewerUserIds: [sme.id], ...body });
  return { sme, pipelineId, roundId: res.body.round.id as string };
}

describe('the expert can find out when their interview is', () => {
  beforeEach(async () => { await wipe(); });

  it('carries the round time on the worklist', async () => {
    const ids = await seeded();
    const { sme } = await assignedAndSeated(ids, 'when-list');

    const res = await request(app).get('/api/sme/assignments').set('Authorization', sme.auth);

    expect(res.body.assignments[0].round).toMatchObject({ scheduledAt: AT });
  });

  it('carries the round time on the candidate', async () => {
    const ids = await seeded();
    const { sme, roundId } = await assignedAndSeated(ids, 'when-detail');

    const res = await request(app).get(`/api/sme/candidates/${ids.candidateId}`).set('Authorization', sme.auth);

    expect(res.body.rounds.map((r: { id: string }) => r.id)).toEqual([roundId]);
  });

  // The zone is the whole point: a bare instant is converted in the reader's
  // head, and wrongly whenever they forget to.
  it('names the zone the round was booked in', async () => {
    const ids = await seeded();
    const { sme } = await assignedAndSeated(ids, 'when-zone', {
      scheduledAt: undefined, date: '2026-11-05', time: '14:30', timeZone: 'Europe/London',
    });

    const res = await request(app).get(`/api/sme/candidates/${ids.candidateId}`).set('Authorization', sme.auth);

    expect(res.body.rounds[0].scheduledTimeZone).toBe('Europe/London');
  });

  // The legacy instant-only booking stores no zone. Every reader then falls
  // back to the organisation's, which for an expert abroad is a wrong time
  // presented as a right one — so the null travels, and the org zone with it.
  it('says nothing rather than guessing when the booking carried no zone', async () => {
    const ids = await seeded();
    const { sme } = await assignedAndSeated(ids, 'when-nozone');

    const res = await request(app).get(`/api/sme/candidates/${ids.candidateId}`).set('Authorization', sme.auth);

    expect(res.body.rounds[0].scheduledTimeZone).toBeNull();
  });

  it('sends the organisation clock along, which this role cannot ask for anywhere else', async () => {
    const ids = await seeded();
    const { sme } = await assignedAndSeated(ids, 'when-orgzone');

    const res = await request(app).get(`/api/sme/candidates/${ids.candidateId}`).set('Authorization', sme.auth);

    expect(typeof res.body.orgTimeZone).toBe('string');
  });

  it('shows no round to an expert who was handed the candidate but is not in the room', async () => {
    const ids = await seeded();
    await assignedAndSeated(ids, 'when-seated');
    const bystander = await expert(ids.tenantId, 'when-bystander');
    await request(app).post(`/api/candidates/${ids.candidateId}/sme`).set('Authorization', ids.auth).send({ userId: bystander.id });

    const res = await request(app).get(`/api/sme/candidates/${ids.candidateId}`).set('Authorization', bystander.auth);

    expect(res.body.rounds).toEqual([]);
  });
});
