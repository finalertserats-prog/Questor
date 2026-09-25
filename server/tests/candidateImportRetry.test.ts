import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

/**
 * A confirm that fails part-way reports each row on its own, and a retry
 * finishes only what is left: nobody is added twice, and a person whose CV
 * did not attach gets just the CV on the retry.
 */

const failures = vi.hoisted(() => ({ create: new Set<string>(), attach: 0, afterStore: new Set<string>() }));

vi.mock('../src/services/candidateCreate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/candidateCreate.js')>();
  return {
    ...real,
    createApplication: async (...args: Parameters<typeof real.createApplication>) => {
      if (failures.create.has(args[1].email)) {
        failures.create.delete(args[1].email);
        throw new Error('database went away');
      }
      return real.createApplication(...args);
    },
    attachResume: async (...args: Parameters<typeof real.attachResume>) => {
      if (failures.attach > 0) {
        failures.attach -= 1;
        throw new Error('disk full');
      }
      const stored = await real.attachResume(...args);
      // The profile is committed; only what follows it fails.
      if (failures.afterStore.delete(args[2].filename)) throw new Error('webhook queue down');
      return stored;
    },
  };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { wipe, DEMO_JD, DEMO_RESUME } = await import('../src/seed/demoData.js');
const { signToken } = await import('../src/services/auth.js');

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let token = '';
let batchId = '';
let first: { rowKey: string; outcome: string; candidateId: string | null; error: string }[] = [];
let second: typeof first = [];

beforeAll(async () => {
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({ email: 'admin@retry.local', password: 'fixture-admin-passphrase', name: 'Admin', tenantName: 'Retry Org' });
  tenantId = reg.body.user.tenantId;
  const user = await prisma.user.create({ data: { tenantId, email: 'recruiter@retry.local', name: 'R', passwordHash: 'x', role: 'recruiter' } });
  token = signToken({ userId: user.id, tenantId, role: 'recruiter', email: user.email });
  const role = await request(app).post('/api/roles').set(auth(token)).send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Retry Role', useLlm: false });
  batchId = (await request(app).post('/api/candidate-imports').set(auth(token)).send({ roleId: role.body.role.id })).body.batch.id;
  await request(app).post(`/api/candidate-imports/${batchId}/cvs`).set(auth(token))
    .attach('files', Buffer.from(`Fine Person\nfine@example.com\n\n${DEMO_RESUME}`), { filename: 'fine.txt', contentType: 'text/plain' })
    .attach('files', Buffer.from(`Broken Create\nbroken@example.com\n\n${DEMO_RESUME}`), { filename: 'broken.txt', contentType: 'text/plain' })
    .attach('files', Buffer.from(`Cv Fails\ncvfails@example.com\n\n${DEMO_RESUME}`), { filename: 'cvfails.txt', contentType: 'text/plain' })
    .attach('files', Buffer.from(`After Commit\nafter@example.com\n\n${DEMO_RESUME}`), { filename: 'after.txt', contentType: 'text/plain' });

  failures.create.add('broken@example.com');
  failures.afterStore.add('after.txt');
  // The first CV attach in the batch fails; rows run in order, so it is fine@example.com's.
  failures.attach = 1;
  first = (await request(app).post(`/api/candidate-imports/${batchId}/confirm`).set(auth(token)).send({ rowKeys: ['r1', 'r2', 'r3', 'r4'] })).body.results;
  second = (await request(app).post(`/api/candidate-imports/${batchId}/confirm`).set(auth(token)).send({ rowKeys: ['r1', 'r2', 'r3', 'r4'] })).body.results;
});

describe('a confirm that fails part-way', () => {
  it('reports each row on its own', () => {
    expect(first.map((r) => r.outcome)).toEqual(['failed', 'failed', 'created', 'created']);
  });

  it('keeps the person whose CV failed, and says so', () => {
    expect(first[0]).toMatchObject({ candidateId: expect.any(String), error: expect.stringMatching(/CV could not be attached/) });
  });

  it('counts a CV as attached when only what follows its storing failed', async () => {
    expect(await prisma.candidateProfileVersion.count({ where: { candidateId: first[3].candidateId! } })).toBe(1);
  });

  it('does not pass an internal error message to the caller', () => {
    expect(first[1].error).not.toContain('database went away');
  });
});

describe('the retry', () => {
  it('finishes every row', () => {
    expect(second.map((r) => r.outcome)).toEqual(['created', 'created', 'created', 'created']);
  });

  it('keeps the same candidate for the row that was already added', () => {
    expect(second[0].candidateId).toBe(first[0].candidateId);
  });

  it('attaches the missing CV exactly once', async () => {
    expect(await prisma.candidateProfileVersion.count({ where: { candidateId: second[0].candidateId! } })).toBe(1);
  });

  it('adds nobody twice', async () => {
    expect(await prisma.candidate.count({ where: { tenantId } })).toBe(4);
  });
});
