import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';

/**
 * Both badges, or neither — and neither without the move.
 *
 * A Gold → Diamond promotion strikes two awards. If they are not written in
 * the same transaction as the move, a failure between them leaves a candidate
 * holding Diamond with no Gold: a journey the row list has no way to render
 * and a certificate has no way to explain, with nothing on the record to say
 * which half was the accident.
 *
 * The failure is forced by pinning every reference to one value and parking
 * that value on another organisation's award first, so the SECOND strike of
 * the promotion — Diamond, after Gold has already been written — cannot mint a
 * free reference and throws. What must then be true is that the Gold award is
 * gone too, and that the candidate is still at Gold.
 */

vi.mock('../src/domain/candidateAwards.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/candidateAwards.js')>();
  return { ...actual, referenceBlocks: () => ({ block: 'ZZZZ', digits: '0000' }) };
});

const { createApp } = await import('../src/app.js');
const app = createApp();

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;

async function pipelineAtGold(ids: Seeded): Promise<string> {
  const created = await request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId: ids.candidateId });
  const id = created.body.pipeline.id as string;
  for (const key of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: key });
  }
  return id;
}

/** Park the reference the Diamond strike will reach for, so that strike cannot finish. */
async function blockDiamondReference(tenantId: string): Promise<void> {
  await prisma.candidateAward.create({
    data: {
      tenantId, candidateId: 'someone-else', roleId: 'another-role', tier: 'diamond',
      reference: 'QS-DIA-ZZZZ-0000', verifyToken: 'parked-token-for-the-atomicity-test',
      evidenceJson: JSON.stringify({ version: 1, rows: [] }),
    },
  });
}

describe('a promotion that earns two badges', () => {
  beforeEach(async () => { await wipe(); });

  it('leaves neither badge behind when the second cannot be struck', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAtGold(ids);
    await blockDiamondReference(ids.tenantId);

    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'diamond' });

    // Silver was struck earlier, by the move out of Silver; the point is that
    // this promotion left neither of the two it was about.
    const held = await prisma.candidateAward.findMany({ where: { candidateId: ids.candidateId, tier: { in: ['gold', 'diamond'] } } });
    expect(held.map((award) => award.tier)).toEqual([]);
  });

  it('leaves the candidate where they were, not half-promoted', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAtGold(ids);
    await blockDiamondReference(ids.tenantId);

    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'diamond' });

    const pipeline = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipelineId } });
    expect(pipeline.currentStageKey).toBe('gold');
  });

  it('refuses the move rather than reporting a promotion it did not make', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAtGold(ids);
    await blockDiamondReference(ids.tenantId);

    const res = await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'diamond' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.pipeline).toBeUndefined();
  });

  it('writes both when nothing stands in the way', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAtGold(ids);

    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'diamond' });

    const held = await prisma.candidateAward.findMany({ where: { candidateId: ids.candidateId }, select: { tier: true } });
    expect(held.map((award) => award.tier).sort()).toEqual(['diamond', 'gold', 'silver']);
  });
});
