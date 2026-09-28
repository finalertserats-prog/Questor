import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { promoteIfEligible, supersedeEntry, transitionEntry } from '../../src/library/lifecycle.js';
import { DEFAULT_POLICY } from '../../src/library/types.js';
import { entry, seedLibraryWorld, type LibraryWorld } from './libraryFixtures.js';

/** Status changes against the database: guarded, recorded, audited, chained. */

let world: LibraryWorld;

beforeEach(async () => {
  world = await seedLibraryWorld();
});

const policyCtx = { actor: 'policy' as const, action: 'test' };

async function use(entryId: string, outcome: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await prisma.libraryUsage.create({ data: { entryId, interviewSessionId: `s-${i}`, tenantId: world.admin.tenantId, roleSlug: world.roleSlug, outcome } });
  }
}

describe('transitionEntry', () => {
  it('refuses a backward move', async () => {
    const row = await entry(world, { status: 'live' });
    expect(await transitionEntry(row.id, 'probational', policyCtx)).toEqual({ ok: false, code: 'invalid_transition' });
  });

  it('reports an unknown entry', async () => {
    expect(await transitionEntry('nope', 'retired', policyCtx)).toEqual({ ok: false, code: 'not_found' });
  });

  it('throws on a reserved id before touching the database', async () => {
    await expect(transitionEntry('__resume_validation__', 'retired', policyCtx)).rejects.toThrow(/reserved/);
  });

  it('writes an audit event for a global entry under the operator\'s organisation', async () => {
    const row = await entry(world, { status: 'probational' });
    await transitionEntry(row.id, 'retired', { actor: 'worker', action: 'retired', reason: 'quality' });
    expect(await prisma.auditEvent.count({ where: { tenantId: world.operator.tenantId, entityId: row.id, action: 'library.entry.retired' } })).toBe(1);
  });

  it('files an org entry\'s audit event under that organisation', async () => {
    const row = await entry(world, { status: 'probational', scope: 'org', tenantId: world.admin.tenantId });
    await transitionEntry(row.id, 'retired', { actor: 'policy', action: 'retired' });
    expect(await prisma.auditEvent.count({ where: { tenantId: world.admin.tenantId, entityId: row.id } })).toBe(1);
  });

  it('never deletes the entry', async () => {
    const row = await entry(world, { status: 'probational' });
    await transitionEntry(row.id, 'rejected', { actor: 'owner', action: 'rejected', reason: 'no' });
    expect(await prisma.libraryEntry.count({ where: { id: row.id } })).toBe(1);
  });
});

describe('supersedeEntry', () => {
  it('links the new draft to the old entry', async () => {
    const row = await entry(world, { status: 'live' });
    const result = await supersedeEntry(row.id, { questionText: 'A reworded question for the Payments Platform Engineer about ledgers?' }, { actor: 'owner', action: 'edited' });
    expect(result.ok && (await prisma.libraryEntry.findUniqueOrThrow({ where: { id: result.newId } })).supersedesId).toBe(row.id);
  });

  it('retires the old entry', async () => {
    const row = await entry(world, { status: 'live' });
    await supersedeEntry(row.id, { questionText: 'A reworded question for the Payments Platform Engineer about ledgers?' }, { actor: 'owner', action: 'edited' });
    expect((await prisma.libraryEntry.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('retired');
  });

  it('puts the new draft in the owner queue', async () => {
    const row = await entry(world, { status: 'live' });
    const result = await supersedeEntry(row.id, { questionText: 'A reworded question for the Payments Platform Engineer about ledgers?' }, { actor: 'owner', action: 'edited' });
    expect(result.ok && (await prisma.libraryEntry.findUniqueOrThrow({ where: { id: result.newId } })).gateOutcome).toBe('unsure');
  });

  it('refuses to supersede a rejected entry', async () => {
    const row = await entry(world, { status: 'rejected' });
    expect((await supersedeEntry(row.id, { questionText: 'A reworded question for the Payments Platform Engineer about ledgers?' }, { actor: 'owner', action: 'edited' })).ok).toBe(false);
  });
});

describe('promoteIfEligible', () => {
  it('promotes after five clean uses', async () => {
    const row = await entry(world, { status: 'probational' });
    await use(row.id, 'answered', 5);
    expect((await promoteIfEligible(row.id, DEFAULT_POLICY)).promoted).toBe(true);
  });

  it('leaves the entry probational below the threshold', async () => {
    const row = await entry(world, { status: 'probational' });
    await use(row.id, 'answered', 4);
    await promoteIfEligible(row.id, DEFAULT_POLICY);
    expect((await prisma.libraryEntry.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('probational');
  });

  it('refuses on a non-answer spike', async () => {
    const row = await entry(world, { status: 'probational' });
    await use(row.id, 'answered', 5);
    await use(row.id, 'non-answer', 3);
    expect((await promoteIfEligible(row.id, DEFAULT_POLICY)).reason).toBe('non_answer_spike');
  });

  it('records the promotion as a policy review', async () => {
    const row = await entry(world, { status: 'probational' });
    await use(row.id, 'answered', 5);
    await promoteIfEligible(row.id, DEFAULT_POLICY);
    expect(await prisma.libraryReview.count({ where: { entryId: row.id, actor: 'policy', action: 'promoted' } })).toBe(1);
  });
});
