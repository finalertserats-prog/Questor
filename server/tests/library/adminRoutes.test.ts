import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { prisma } from '../../src/db.js';
import { setWorkerState } from '../../src/library/workerState.js';
import { bearer, entry, seedLibraryWorld, type LibraryWorld } from './libraryFixtures.js';

/** The owner's screen: operator-only, the queue, decisions, the sample, health and state. */

let world: LibraryWorld;
// The flag is read when the app is built, so it is set before that.
config.library.enabled = true;
const app = createApp();

beforeEach(async () => {
  world = await seedLibraryWorld();
  config.library.enabled = true;
});

const get = (path: string, token: string) => request(app).get(`/api/library/admin${path}`).set('Authorization', bearer(token));
const post = (path: string, token: string, body: unknown = {}) => request(app).post(`/api/library/admin${path}`).set('Authorization', bearer(token)).send(body);

describe('access', () => {
  it('refuses an organisation admin', async () => {
    expect((await get('/overview', world.admin.token)).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await request(app).get('/api/library/admin/overview')).status).toBe(401);
  });

  it('admits the platform owner', async () => {
    expect((await get('/overview', world.operator.token)).status).toBe(200);
  });
});

describe('overview', () => {
  it('reports the worker state', async () => {
    await setWorkerState('waiting_for_credits', { reason: 'OpenAI 429 insufficient_quota' });
    expect((await get('/overview', world.operator.token)).body.worker.state).toBe('waiting_for_credits');
  });

  it('says whether the critic is configured', async () => {
    expect((await get('/overview', world.operator.token)).body.critic.configured).toBe(config.llm.anthropicKey.length > 0);
  });

  it('counts the owner queue', async () => {
    await entry(world, { status: 'draft' });
    await entry(world, { status: 'draft' });
    expect((await get('/overview', world.operator.token)).body.queueTotal).toBe(2);
  });
});

describe('pool health', () => {
  it('reports depth against target', async () => {
    await prisma.libraryPoolTarget.create({ data: { roleSlug: world.roleSlug, competencyKey: world.competencyKeys[0], band: 'established', depthTarget: 12 } });
    await entry(world);
    const pools = (await get('/pools', world.operator.token)).body.pools as { competencyKey: string; live: number; target: number; health: string }[];
    expect(pools.find((p) => p.competencyKey === world.competencyKeys[0])).toMatchObject({ live: 1, target: 12, health: 'thin' });
  });
});

describe('the owner queue', () => {
  it('lists drafts the gate was unsure about', async () => {
    const row = await entry(world, { status: 'draft' });
    await entry(world, { status: 'probational' });
    expect((await get('/queue', world.operator.token)).body.entries.map((e: { id: string }) => e.id)).toEqual([row.id]);
  });

  it('approves into probational', async () => {
    const row = await entry(world, { status: 'draft' });
    await post(`/entries/${row.id}/approve`, world.operator.token);
    expect((await prisma.libraryEntry.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('probational');
  });

  it('counts an approval toward opening the stratum', async () => {
    const row = await entry(world, { status: 'draft' });
    await post(`/entries/${row.id}/approve`, world.operator.token);
    expect((await prisma.libraryStratum.findUniqueOrThrow({ where: { key: row.stratumKey } })).cleanApprovals).toBe(1);
  });

  it('writes a review row naming the owner', async () => {
    const row = await entry(world, { status: 'draft' });
    await post(`/entries/${row.id}/approve`, world.operator.token, { note: 'fine' });
    expect(await prisma.libraryReview.count({ where: { entryId: row.id, actor: 'owner', action: 'approved' } })).toBe(1);
  });

  it('writes an audit event under the owner\'s organisation', async () => {
    const row = await entry(world, { status: 'draft' });
    await post(`/entries/${row.id}/approve`, world.operator.token);
    expect(await prisma.auditEvent.count({ where: { tenantId: world.operator.tenantId, action: 'library.entry.approved', entityId: row.id } })).toBe(1);
  });

  it('rejects with a reason', async () => {
    const row = await entry(world, { status: 'draft' });
    await post(`/entries/${row.id}/reject`, world.operator.token, { reason: 'generic' });
    expect((await prisma.libraryReview.findFirstOrThrow({ where: { entryId: row.id, action: 'rejected' } })).reason).toBe('generic');
  });

  it('requires a reason to reject', async () => {
    const row = await entry(world, { status: 'draft' });
    expect((await post(`/entries/${row.id}/reject`, world.operator.token, {})).status).toBe(400);
  });

  it('edits into a new draft that supersedes the old entry', async () => {
    const row = await entry(world, { status: 'draft' });
    const res = await post(`/entries/${row.id}/edit`, world.operator.token, { questionText: 'Walk me through the last settlement run you owned as a Payments Platform Engineer?' });
    expect((await prisma.libraryEntry.findUniqueOrThrow({ where: { id: res.body.newId } })).supersedesId).toBe(row.id);
  });

  it('retires the edited entry', async () => {
    const row = await entry(world, { status: 'draft' });
    await post(`/entries/${row.id}/edit`, world.operator.token, { questionText: 'Walk me through the last settlement run you owned as a Payments Platform Engineer?' });
    expect((await prisma.libraryEntry.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('retired');
  });

  it('refuses an edit that fails the linter', async () => {
    const row = await entry(world, { status: 'draft' });
    const res = await post(`/entries/${row.id}/edit`, world.operator.token, { questionText: 'Are you married, and would that affect the on-call rota for settlements?' });
    expect(res.status).toBe(422);
  });

  it('refuses to approve a live entry again', async () => {
    const row = await entry(world, { status: 'live' });
    expect((await post(`/entries/${row.id}/approve`, world.operator.token)).status).toBe(409);
  });

  it('refuses a reserved id', async () => {
    expect((await post('/entries/__opening__/approve', world.operator.token)).status).toBe(400);
  });
});

describe('the daily sample', () => {
  it('draws at most twenty entries', async () => {
    for (let i = 0; i < 25; i++) await entry(world, { status: 'probational', form: i % 2 ? 'star' : 'opinion' });
    expect((await get('/sample', world.operator.token)).body.entries.length).toBe(20);
  });

  it('shows the same sample on a second look', async () => {
    for (let i = 0; i < 5; i++) await entry(world, { status: 'probational' });
    const first = (await get('/sample', world.operator.token)).body.entries.map((e: { id: string }) => e.id);
    const second = (await get('/sample', world.operator.token)).body.entries.map((e: { id: string }) => e.id);
    expect(second).toEqual(first);
  });

  it('tightens the stratum gate when a sampled entry is rejected', async () => {
    const row = await entry(world, { status: 'probational' });
    await get('/sample', world.operator.token);
    await post(`/entries/${row.id}/reject`, world.operator.token, { reason: 'not this role' });
    expect((await prisma.libraryStratum.findUniqueOrThrow({ where: { key: row.stratumKey } })).tightenedRemaining).toBe(200);
  });
});

describe('the entry view', () => {
  it('returns the critic verdict and history', async () => {
    const row = await entry(world, { status: 'draft' });
    await post(`/entries/${row.id}/approve`, world.operator.token);
    const res = await get(`/entries/${row.id}`, world.operator.token);
    expect(res.body.history.map((h: { action: string }) => h.action)).toEqual(['approved']);
  });

  it('reports rates by stratum', async () => {
    await entry(world, { status: 'probational' });
    await entry(world, { status: 'rejected' });
    const strata = (await get('/strata', world.operator.token)).body.strata as { rejectionRate: number }[];
    expect(strata[0].rejectionRate).toBe(0.5);
  });
});
