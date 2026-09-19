import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { normalizeTitle } from '../src/domain/catalogText.js';
import { bearer, proposal, seedReviewWorld, type ReviewWorld } from './catalogReviewFixtures.js';

/**
 * Approval is the only way anything enters the shared catalog. It must create
 * exactly one row however many clicks race, refuse what is no longer valid,
 * and leave an audit trail of every decision.
 */

const app = createApp();
let world: ReviewWorld;

beforeEach(async () => {
  world = await seedReviewWorld();
});

function approve(id: string, body: object = {}) {
  return request(app).post(`/api/catalog-review/proposals/${id}/approve`).set('Authorization', bearer(world.operator.token)).send(body);
}

function reject(id: string, body: object = {}) {
  return request(app).post(`/api/catalog-review/proposals/${id}/reject`).set('Authorization', bearer(world.operator.token)).send(body);
}

async function auditActions(entityId: string): Promise<string[]> {
  return (await prisma.auditEvent.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } })).map((e) => e.action);
}

describe('approving a new role', () => {
  it('creates an active catalog role from the automation', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer', familyId: world.catalog.engFamilyId, summary: 'Keeps AI agents dependable.' });
    const res = await approve(p.id);
    const role = await prisma.catalogRole.findFirstOrThrow({ where: { normalizedTitle: 'agent reliability engineer' } });
    expect({ status: res.status, role: { source: role.source, status: role.status, domainId: role.domainId, familyId: role.familyId, summary: role.summary, createdByTenantId: role.createdByTenantId } }).toEqual({
      status: 200,
      role: { source: 'automation', status: 'active', domainId: world.catalog.techId, familyId: world.catalog.engFamilyId, summary: 'Keeps AI agents dependable.', createdByTenantId: null },
    });
  });

  it('marks the proposal approved with the reviewer, the note and the new role', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    await approve(p.id, { note: 'Seen widely.' });
    const row = await prisma.catalogProposal.findUniqueOrThrow({ where: { id: p.id } });
    const role = await prisma.catalogRole.findFirstOrThrow({ where: { normalizedTitle: 'agent reliability engineer' } });
    expect({ status: row.status, by: row.reviewedById, note: row.reviewerNote, created: row.createdCatalogRoleId, at: row.reviewedAt !== null }).toEqual({ status: 'approved', by: world.operator.id, note: 'Seen widely.', created: role.id, at: true });
  });

  it('records the approval in the audit log', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    await approve(p.id);
    expect(await auditActions(p.id)).toEqual(['catalog.proposal.approved']);
  });

  it('makes the new title findable by the role title search', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    await approve(p.id);
    const res = await request(app).get(`/api/catalog/roles?domainId=${world.catalog.techId}&q=agent%20reliability`).set('Authorization', bearer(world.admin.token));
    expect(JSON.stringify(res.body)).toContain('Agent Reliability Engineer');
  });

  it('refuses a new role with no domain', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer', domainId: null });
    const res = await approve(p.id);
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 400, error: 'Choose a domain before approving' });
  });

  it('refuses a family that does not belong to the domain', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer', familyId: world.catalog.careFamilyId });
    expect((await approve(p.id)).status).toBe(400);
  });

  it('refuses a title the shared catalog must not hold', async () => {
    const p = await proposal(world, { title: 'Call 5551234567' });
    expect((await approve(p.id)).status).toBe(400);
  });

  it('answers 404 for an unknown proposal', async () => {
    expect((await approve('cjld2cjxh0000qzrmn831i7rn')).status).toBe(404);
  });

  it('answers 409 for a proposal already reviewed', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer', status: 'rejected' });
    expect((await approve(p.id)).status).toBe(409);
  });

  it('refuses unknown fields in the body', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    expect((await approve(p.id, { note: 'ok', status: 'approved' })).status).toBe(400);
  });
});

describe('when a matching role appeared meanwhile', () => {
  async function supersededSetup() {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    const existing = await prisma.catalogRole.create({ data: { domainId: world.catalog.techId, title: 'Agent Reliability Engineer', normalizedTitle: normalizeTitle('Agent Reliability Engineer'), source: 'org' } });
    return { p, existing, res: await approve(p.id) };
  }

  it('answers 409 with the existing role', async () => {
    const { existing, res } = await supersededSetup();
    expect({ status: res.status, code: res.body.code, existing: res.body.existing }).toEqual({ status: 409, code: 'superseded', existing: { id: existing.id, title: 'Agent Reliability Engineer' } });
  });

  it('marks the proposal superseded and creates nothing', async () => {
    const { p } = await supersededSetup();
    const [row, count] = await Promise.all([prisma.catalogProposal.findUniqueOrThrow({ where: { id: p.id } }), prisma.catalogRole.count({ where: { normalizedTitle: 'agent reliability engineer' } })]);
    expect({ status: row.status, count }).toEqual({ status: 'superseded', count: 1 });
  });

  it('audits it as superseded, not approved', async () => {
    const { p } = await supersededSetup();
    expect(await auditActions(p.id)).toEqual(['catalog.proposal.superseded']);
  });

  it('treats a matching alias as the same role', async () => {
    await prisma.catalogRoleAlias.create({ data: { roleId: world.catalog.sweId, alias: 'Agent Reliability Engineer', normalizedAlias: 'agent reliability engineer', source: 'seed' } });
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    const res = await approve(p.id);
    expect({ status: res.status, existing: res.body.existing?.id }).toEqual({ status: 409, existing: world.catalog.sweId });
  });
});

describe('approving what the operator actually saw', () => {
  it('refuses an approval of a version that was edited since', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    const seen = p.updatedAt.toISOString();
    await request(app).patch(`/api/catalog-review/proposals/${p.id}`).set('Authorization', bearer(world.operator.token)).send({ title: 'Agent Reliability Lead' });
    const res = await approve(p.id, { updatedAt: seen });
    const roles = await prisma.catalogRole.count({ where: { normalizedTitle: { startsWith: 'agent reliability' } } });
    expect({ status: res.status, code: res.body.code, roles }).toEqual({ status: 409, code: 'changed', roles: 0 });
  });

  it('approves the version the operator saw', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    expect((await approve(p.id, { updatedAt: p.updatedAt.toISOString() })).status).toBe(200);
  });
});

// The suite also runs on Postgres, whose triggers are written differently.
const onPostgres = /^postgres(ql)?:/.test(process.env.DATABASE_URL ?? '');

async function createFailingRoleTrigger(): Promise<void> {
  if (!onPostgres) {
    await prisma.$executeRawUnsafe(`CREATE TRIGGER IF NOT EXISTS "fail_role_insert" BEFORE INSERT ON "CatalogRole" WHEN NEW."title" = 'Boom Title' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    return;
  }
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_role_insert() RETURNS trigger AS $$ BEGIN IF NEW."title" = 'Boom Title' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "fail_role_insert" BEFORE INSERT ON "CatalogRole" FOR EACH ROW EXECUTE FUNCTION fail_role_insert()`);
}

async function dropFailingRoleTrigger(): Promise<void> {
  if (!onPostgres) {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "fail_role_insert"');
    return;
  }
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "fail_role_insert" ON "CatalogRole"');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_role_insert()');
}

describe('when the catalog write fails', () => {
  it('leaves the proposal pending, to be approved again', async () => {
    // A trigger stands in for any failure between claiming the proposal and creating the role.
    await createFailingRoleTrigger();
    try {
      const p = await proposal(world, { title: 'Boom Title' });
      const res = await approve(p.id);
      const row = await prisma.catalogProposal.findUniqueOrThrow({ where: { id: p.id } });
      expect({ status: res.status, proposal: row.status, reviewedAt: row.reviewedAt }).toEqual({ status: 500, proposal: 'pending', reviewedAt: null });
    } finally {
      await dropFailingRoleTrigger();
    }
  });
});

describe('two operators approving at once', () => {
  it('creates exactly one role', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    await Promise.all([approve(p.id), approve(p.id), approve(p.id)]);
    expect(await prisma.catalogRole.count({ where: { normalizedTitle: 'agent reliability engineer' } })).toBe(1);
  });

  it('lets exactly one approval succeed', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    const results = await Promise.all([approve(p.id), approve(p.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('approving an alternative title', () => {
  it('adds the alias to its role, with the first source as its source', async () => {
    const p = await proposal(world, { kind: 'new_alias', title: 'Application Developer', sources: [{ source: 'esco', ref: 'uri-1' }, { source: 'onet', ref: '15-1252.00' }] });
    const res = await approve(p.id);
    const alias = await prisma.catalogRoleAlias.findFirstOrThrow({ where: { normalizedAlias: 'application developer' } });
    expect({ status: res.status, roleId: alias.roleId, source: alias.source, aliasStatus: alias.status }).toEqual({ status: 200, roleId: world.catalog.sweId, source: 'esco', aliasStatus: 'active' });
  });

  it('refuses when the role is no longer active', async () => {
    await prisma.catalogRole.update({ where: { id: world.catalog.sweId }, data: { status: 'retired' } });
    const p = await proposal(world, { kind: 'new_alias', title: 'Application Developer' });
    expect((await approve(p.id)).status).toBe(400);
  });

  it('is superseded when the role gained the alias meanwhile', async () => {
    const p = await proposal(world, { kind: 'new_alias', title: 'Application Developer' });
    await prisma.catalogRoleAlias.create({ data: { roleId: world.catalog.sweId, alias: 'Application developer', normalizedAlias: 'application developer', source: 'org' } });
    const res = await approve(p.id);
    const row = await prisma.catalogProposal.findUniqueOrThrow({ where: { id: p.id } });
    expect({ status: res.status, code: res.body.code, proposal: row.status, existing: res.body.existing }).toEqual({ status: 409, code: 'superseded', proposal: 'superseded', existing: { id: world.catalog.sweId, title: 'Software Engineer' } });
  });

  it('adds exactly one alias when approved twice at once', async () => {
    const p = await proposal(world, { kind: 'new_alias', title: 'Application Developer' });
    await Promise.all([approve(p.id), approve(p.id)]);
    expect(await prisma.catalogRoleAlias.count({ where: { normalizedAlias: 'application developer' } })).toBe(1);
  });
});

describe('rejecting', () => {
  it('marks the proposal rejected with the note and reviewer', async () => {
    const p = await proposal(world, { title: 'Vibe Coder' });
    const res = await reject(p.id, { note: 'Not a real title.' });
    const row = await prisma.catalogProposal.findUniqueOrThrow({ where: { id: p.id } });
    expect({ status: res.status, row: row.status, note: row.reviewerNote, by: row.reviewedById }).toEqual({ status: 200, row: 'rejected', note: 'Not a real title.', by: world.operator.id });
  });

  it('records the rejection in the audit log', async () => {
    const p = await proposal(world, { title: 'Vibe Coder' });
    await reject(p.id);
    expect(await auditActions(p.id)).toEqual(['catalog.proposal.rejected']);
  });

  it('answers 409 when the proposal is no longer pending', async () => {
    const p = await proposal(world, { title: 'Vibe Coder', status: 'approved' });
    expect((await reject(p.id)).status).toBe(409);
  });

  it('answers 404 for an unknown proposal', async () => {
    expect((await reject('cjld2cjxh0000qzrmn831i7rn')).status).toBe(404);
  });

  it('adds nothing to the catalog', async () => {
    const before = await prisma.catalogRole.count();
    const p = await proposal(world, { title: 'Vibe Coder' });
    await reject(p.id);
    expect(await prisma.catalogRole.count()).toBe(before);
  });
});

describe('bulk review', () => {
  function bulk(body: object) {
    return request(app).post('/api/catalog-review/proposals/bulk').set('Authorization', bearer(world.operator.token)).send(body);
  }

  it('reports a result per item, with codes for the failures', async () => {
    const ok = await proposal(world, { title: 'Agent Reliability Engineer' });
    const noDomain = await proposal(world, { title: 'Prompt Librarian', domainId: null });
    const done = await proposal(world, { title: 'Eval Engineer', status: 'rejected' });
    const res = await bulk({ ids: [ok.id, noDomain.id, done.id], action: 'approve' });
    expect(res.body.results.map((r: { id: string; ok: boolean; code?: string }) => [r.id, r.ok, r.code ?? null])).toEqual([
      [ok.id, true, null],
      [noDomain.id, false, 'needs_domain'],
      [done.id, false, 'not_pending'],
    ]);
  });

  it('audits every item it decided', async () => {
    const a = await proposal(world, { title: 'Vibe Coder' });
    const b = await proposal(world, { title: 'Prompt Poet' });
    await bulk({ ids: [a.id, b.id], action: 'reject', note: 'Noise.' });
    expect([...(await auditActions(a.id)), ...(await auditActions(b.id))]).toEqual(['catalog.proposal.rejected', 'catalog.proposal.rejected']);
  });

  it('refuses more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `cjld2cjxh0000qzrmn831i${String(i).padStart(3, '0')}`);
    expect((await bulk({ ids, action: 'reject' })).status).toBe(400);
  });

  it('refuses an unknown action', async () => {
    const a = await proposal(world, { title: 'Vibe Coder' });
    expect((await bulk({ ids: [a.id], action: 'delete' })).status).toBe(400);
  });

  it('reports an unknown id as not found without stopping the rest', async () => {
    const a = await proposal(world, { title: 'Vibe Coder' });
    const res = await bulk({ ids: ['cjld2cjxh0000qzrmn831i7rn', a.id], action: 'reject' });
    expect(res.body.results.map((r: { ok: boolean; code?: string }) => [r.ok, r.code ?? null])).toEqual([[false, 'not_found'], [true, null]]);
  });
});
