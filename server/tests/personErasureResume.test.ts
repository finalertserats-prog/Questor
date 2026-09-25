import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Erasing every application of a person can fail part-way (a database error
 * on one row). What was erased stays erased; the rest must still be reachable,
 * so the obvious retry from the same record finishes the job instead of
 * answering 404 because the record it started from is already gone.
 */

const failing = new Set<string>();

vi.mock('../src/services/dataRights.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/dataRights.js')>();
  return {
    ...actual,
    eraseCandidate: async (o: Parameters<typeof actual.eraseCandidate>[0]) => {
      if (failing.has(o.candidateId)) throw new Error('connection reset');
      return actual.eraseCandidate(o);
    },
  };
});

const { prisma } = await import('../src/db.js');
const { wipe } = await import('../src/seed/demoData.js');
const { eraseAllApplications } = await import('../src/services/personErasure.js');

interface Person {
  readonly tenantId: string;
  readonly actorId: string;
  readonly ids: readonly string[];
}

async function personWithThreeApplications(): Promise<Person> {
  const tenant = await prisma.tenant.create({ data: { name: 'Resume Org' } });
  const admin = await prisma.user.create({ data: { tenantId: tenant.id, email: `admin-${Date.now()}@resume.local`, name: 'Admin', passwordHash: 'x', role: 'admin' } });
  const rows = await Promise.all([0, 1, 2].map(() => prisma.candidate.create({
    data: { tenantId: tenant.id, fullName: 'Asha Rao', email: 'asha@example.com', emailNormalized: 'asha@example.com' },
  })));
  return { tenantId: tenant.id, actorId: admin.id, ids: rows.map((r) => r.id).sort() };
}

const eraseAll = (p: Person, candidateId: string) =>
  eraseAllApplications({ tenantId: p.tenantId, candidateId, actorId: p.actorId, reason: 'Asked to be forgotten.' });

const remaining = (p: Person) => prisma.candidate.count({ where: { tenantId: p.tenantId } });

beforeEach(async () => {
  failing.clear();
  await wipe();
});

describe('an erase-all that fails on one application', () => {
  it('does not throw, and reports the application it could not erase', async () => {
    const p = await personWithThreeApplications();
    failing.add(p.ids[0]);

    const result = await eraseAll(p, p.ids[2]);

    expect(result.failed.map((f) => f.candidateId)).toEqual([p.ids[0]]);
  });

  it('keeps the requested record, so the retry has somewhere to start', async () => {
    const p = await personWithThreeApplications();
    failing.add(p.ids[0]);

    const result = await eraseAll(p, p.ids[2]);

    expect({ erased: result.erased, stillThere: await prisma.candidate.count({ where: { id: p.ids[2] } }) }).toEqual({ erased: false, stillThere: 1 });
  });

  it('writes the person-level audit entry anyway', async () => {
    const p = await personWithThreeApplications();
    failing.add(p.ids[0]);

    await eraseAll(p, p.ids[2]);

    expect(await prisma.auditEvent.count({ where: { tenantId: p.tenantId, action: 'candidate.erased_all_applications' } })).toBe(1);
  });

  it('finishes the job when retried from the same record', async () => {
    const p = await personWithThreeApplications();
    failing.add(p.ids[0]);
    await eraseAll(p, p.ids[2]);
    failing.clear();

    const retry = await eraseAll(p, p.ids[2]);

    expect({ erased: retry.erased, left: await remaining(p) }).toEqual({ erased: true, left: 0 });
  });

  it('finishes the job when the requested record itself failed and is retried', async () => {
    const p = await personWithThreeApplications();
    failing.add(p.ids[2]);
    await eraseAll(p, p.ids[2]);
    failing.clear();

    await eraseAll(p, p.ids[2]);

    expect(await remaining(p)).toBe(0);
  });

  it('erases the requested record last when everything else went', async () => {
    const p = await personWithThreeApplications();

    const result = await eraseAll(p, p.ids[0]);

    expect(result.erasedIds.at(-1)).toBe(p.ids[0]);
  });
});
