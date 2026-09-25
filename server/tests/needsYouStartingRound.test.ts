import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { collectNeedsYou } from '../src/services/needsYouRows.js';

/**
 * The one round that belongs in "Needs you".
 *
 * The queue is the things only a person can move on. A round booked for next
 * Tuesday is a commitment, not an action — put every one of those in the list
 * and it becomes a calendar with rows nobody can clear for a week. So the row
 * exists only while joining is the thing to do: it appears shortly before the
 * round is due and takes itself out again when the round is over.
 */

const app = createApp();

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { tenantId: ids.tenantId, candidateId: ids.candidateId, auth: `Bearer ${login.body.token as string}` };
}

async function colleague(tenantId: string, handle: string, role: 'recruiter' | 'sme' = 'recruiter') {
  const user = await prisma.user.create({
    data: { tenantId, email: `${handle}@demo.local`, name: handle, passwordHash: 'x', role },
  });
  return { id: user.id, auth: `Bearer ${signToken({ userId: user.id, tenantId, role, email: user.email })}` };
}

async function pipelineAtGold(auth: string, candidateId: string) {
  const created = await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId });
  const id = created.body.pipeline.id as string;
  for (const toStageKey of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', auth).send({ toStageKey });
  }
  return id;
}

/**
 * Booked far out, then moved to where the test needs it. The route refuses a
 * round in the past on purpose, and a test that reached around that refusal
 * would be asserting against a state the product cannot produce.
 */
async function roundAt(ids: Awaited<ReturnType<typeof seeded>>, seatId: string, at: Date, durationMinutes = 45, pipeline?: string) {
  const pipelineId = pipeline ?? await pipelineAtGold(ids.auth, ids.candidateId);
  const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set('Authorization', ids.auth)
    .send({ stageKey: 'gold', scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), interviewerUserIds: [seatId], durationMinutes });
  const roundId = res.body.round.id as string;
  await prisma.interviewRound.update({ where: { id: roundId }, data: { scheduledAt: at } });
  return roundId;
}

const queue = (auth: string) => request(app).get('/api/dashboard/needs-you').set('Authorization', auth);
const startingRows = (body: { needsYou: { items: Array<{ kind: string; id: string }> } }) =>
  body.needsYou.items.filter((r) => r.kind === 'round_starting');

describe('a round you are seated on in the "Needs you" queue', () => {
  beforeEach(async () => { await wipe(); });

  it('appears once the round is nearly due', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'starting-soon');
    const roundId = await roundAt(ids, seat.id, new Date(Date.now() + 5 * 60_000));

    const res = await queue(seat.auth);

    expect(startingRows(res.body).map((r) => r.id)).toEqual([`round_starting:${roundId}`]);
  });

  it('stays out of the queue while the round is still days away', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'starting-later');
    await roundAt(ids, seat.id, new Date(Date.now() + 3 * 86_400_000));

    const res = await queue(seat.auth);

    expect(startingRows(res.body)).toHaveLength(0);
  });

  it('is still there while the round is running', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'starting-live');
    await roundAt(ids, seat.id, new Date(Date.now() - 10 * 60_000), 45);

    const res = await queue(seat.auth);

    expect(startingRows(res.body)).toHaveLength(1);
  });

  // The row clears itself. Nobody marks it done, because there is nothing to
  // mark: the thing it asked for either happened or did not.
  it('takes itself out once the round is over', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'starting-done');
    await roundAt(ids, seat.id, new Date(Date.now() - 60 * 60_000), 30);

    const res = await queue(seat.auth);

    expect(startingRows(res.body)).toHaveLength(0);
  });

  // The round is on a candidate the booker owns, so candidate scope alone
  // would have handed it to them. The seat is the scope, not the candidate.
  it('is not shown to a colleague who is not in the room', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'starting-seated');
    await roundAt(ids, seat.id, new Date(Date.now() + 5 * 60_000));

    const res = await queue(ids.auth);

    expect(startingRows(res.body)).toHaveLength(0);
  });

  /**
   * What an expert's row would carry if they could reach the queue.
   *
   * They cannot today: /api/dashboard/needs-you is gated on `candidate:read`
   * and an SME holds none. But the kind's gate admits `sme:assigned_read`, so
   * the grant is already written and waiting for somebody to widen the route —
   * and a seat is not an assignment. These go through `collectNeedsYou`
   * directly, which is the layer that would be exposed, so they fail the day
   * the route opens with the leak still in it rather than after.
   */
  describe('an expert seated on the round', () => {
    const claims = (userId: string, tenantId: string) => ({ userId, tenantId, role: 'sme', email: 'e@demo.local' });

    it('is not told who the candidate is when all they hold is the seat', async () => {
      const ids = await seeded();
      const sme = await colleague(ids.tenantId, 'sme-seat-only', 'sme');
      await roundAt(ids, sme.id, new Date(Date.now() + 5 * 60_000));

      const { rows } = await collectNeedsYou(claims(sme.id, ids.tenantId), new Date());

      expect(rows.filter((r) => r.kind === 'round_starting').map((r) => r.candidate)).toEqual([null]);
    });

    it('is sent to their own worklist, not to a candidate page their assignment would refuse', async () => {
      const ids = await seeded();
      const sme = await colleague(ids.tenantId, 'sme-seat-link', 'sme');
      await roundAt(ids, sme.id, new Date(Date.now() + 5 * 60_000));

      const { rows } = await collectNeedsYou(claims(sme.id, ids.tenantId), new Date());

      expect(rows.find((r) => r.kind === 'round_starting')?.action.to).toBe('/sme');
    });

    it('keeps the role title back too, which names the requisition', async () => {
      const ids = await seeded();
      const sme = await colleague(ids.tenantId, 'sme-seat-role', 'sme');
      await roundAt(ids, sme.id, new Date(Date.now() + 5 * 60_000));

      const { rows } = await collectNeedsYou(claims(sme.id, ids.tenantId), new Date());

      expect(rows.find((r) => r.kind === 'round_starting')?.role).toBeNull();
    });

    it('still gets the row, because they do have somewhere to be', async () => {
      const ids = await seeded();
      const sme = await colleague(ids.tenantId, 'sme-seat-row', 'sme');
      await roundAt(ids, sme.id, new Date(Date.now() + 5 * 60_000));

      const { rows } = await collectNeedsYou(claims(sme.id, ids.tenantId), new Date());

      expect(rows.filter((r) => r.kind === 'round_starting')).toHaveLength(1);
    });

    // Assigned is the entitlement the owner actually granted, and it is the
    // only thing that turns the name back on.
    it('is named the candidate once they have actually been assigned them', async () => {
      const ids = await seeded();
      const sme = await colleague(ids.tenantId, 'sme-assigned', 'sme');
      await request(app).post(`/api/candidates/${ids.candidateId}/sme`).set('Authorization', ids.auth).send({ userId: sme.id });
      await roundAt(ids, sme.id, new Date(Date.now() + 5 * 60_000));

      const { rows } = await collectNeedsYou(claims(sme.id, ids.tenantId), new Date());
      const row = rows.find((r) => r.kind === 'round_starting');

      expect([row?.candidate?.id, row?.action.to]).toEqual([ids.candidateId, `/sme/candidates/${ids.candidateId}`]);
    });
  });

  it('offers the meeting itself when the round has a link', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'starting-link');
    const roundId = await roundAt(ids, seat.id, new Date(Date.now() + 5 * 60_000));
    await prisma.interviewRound.update({ where: { id: roundId }, data: { meetingUrl: 'https://meet.example.com/room' } });

    const res = await queue(seat.auth);

    expect(startingRows(res.body)[0]).toMatchObject({ action: { label: 'Join', to: 'https://meet.example.com/room', external: true } });
  });

  // The bell reads one row per kind, because every other kind counts with its
  // own query. This one counts from the rows, so a shallow read would have
  // told somebody with two rounds at once that they had one.
  it('counts every seated round in the bell, not just the first', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'starting-bell');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);
    await roundAt(ids, seat.id, new Date(Date.now() + 5 * 60_000), 45, pipelineId);
    await roundAt(ids, seat.id, new Date(Date.now() + 8 * 60_000), 45, pipelineId);

    const res = await request(app).get('/api/dashboard/needs-you/count').set('Authorization', seat.auth);

    expect(res.body.total).toBe(2);
  });
});
