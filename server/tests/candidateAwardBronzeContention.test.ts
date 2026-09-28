import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/db.js';
import { createDemoData, wipe, DEMO_RESUME } from '../src/seed/demoData.js';

/**
 * A badge that cannot be struck must never cost the candidate their profile.
 *
 * Two resume uploads for the same person landing together both find no Bronze
 * and both try to strike one. The loser's insert fails the (candidate, role,
 * tier) key — and on PostgreSQL a failed statement aborts the whole
 * transaction, which here is the profile write, the evidence graph and the
 * stored CV. Losing all of that because a badge the candidate already holds
 * could not be struck a second time is the wrong trade by a wide margin.
 *
 * The race is forced rather than raced: the first strike is made to fail with
 * the error the database would raise, and what must then be true is that the
 * upload still succeeds and leaves exactly one profile version.
 */

const contention = vi.hoisted(() => ({ failFirstStrike: false, breakInstead: false, attempts: 0 }));

vi.mock('../src/services/candidateAwards.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/candidateAwards.js')>();
  return {
    ...actual,
    awardBronze: async (...args: Parameters<typeof actual.awardBronze>) => {
      contention.attempts += 1;
      if (contention.failFirstStrike && contention.attempts === 1) {
        if (contention.breakInstead) throw new Error('The award engine is broken.');
        // Shaped as Prisma raises it, so isAwardConflict has to recognise it
        // the same way it would in production.
        throw Object.assign(new Error('Unique constraint failed on the fields: (`candidateId`,`roleId`,`tier`)'), {
          code: 'P2002', meta: { target: ['candidateId', 'roleId', 'tier'] },
        });
      }
      return actual.awardBronze(...args);
    },
  };
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

async function newApplicant(ids: Seeded): Promise<string> {
  const created = await request(app).post('/api/candidates').set('Authorization', ids.auth)
    .send({ fullName: 'Mei Lin Chua', email: 'mei.lin.chua@example.com', roleId: ids.roleId });
  return created.body.candidate.id as string;
}

const upload = (ids: Seeded, candidateId: string) =>
  request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', ids.auth).field('text', DEMO_RESUME);

beforeEach(async () => {
  await wipe();
  contention.failFirstStrike = false;
  contention.breakInstead = false;
  contention.attempts = 0;
});

describe('a Bronze that another upload struck first', () => {
  it('still stores the profile the upload was for', async () => {
    const ids = await seeded();
    const candidateId = await newApplicant(ids);
    contention.failFirstStrike = true;

    const res = await upload(ids, candidateId);

    expect(res.status).toBe(201);
  });

  it('leaves one profile version, not the two a blind retry would write', async () => {
    const ids = await seeded();
    const candidateId = await newApplicant(ids);
    contention.failFirstStrike = true;

    await upload(ids, candidateId);

    expect(await prisma.candidateProfileVersion.count({ where: { candidateId } })).toBe(1);
  });

  it('retries the write once, without trying to strike the badge again', async () => {
    const ids = await seeded();
    const candidateId = await newApplicant(ids);
    contention.failFirstStrike = true;

    await upload(ids, candidateId);

    // One attempt. The retry passes strikeBronze: false, so it never reaches
    // the engine at all — which is what keeps the second write short.
    expect(contention.attempts).toBe(1);
  });

  it('strikes the badge as usual when nothing is racing it', async () => {
    const ids = await seeded();
    const candidateId = await newApplicant(ids);

    await upload(ids, candidateId);

    const held = await prisma.candidateAward.findMany({ where: { candidateId }, select: { tier: true } });
    expect(held.map((award) => award.tier)).toEqual(['bronze']);
  });

  // A fault that is not "this tier is already held" is a real fault. Retrying
  // it would hide it behind a second write that quietly drops the badge, and
  // nobody would learn the engine is broken.
  it('does not retry a failure that is not a tier already held', async () => {
    const ids = await seeded();
    const candidateId = await newApplicant(ids);
    contention.failFirstStrike = true;
    contention.breakInstead = true;

    const res = await upload(ids, candidateId);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(contention.attempts).toBe(1);
    expect(await prisma.candidateProfileVersion.count({ where: { candidateId } })).toBe(0);
  });
});
