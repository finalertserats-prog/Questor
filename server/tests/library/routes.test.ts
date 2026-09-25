import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { prisma } from '../../src/db.js';
import { BAND, bearer, entry, seedLibraryWorld, type LibraryWorld } from './libraryFixtures.js';

/** The tenant-facing read API: flag-gated, tenant-scoped, empty ladders for thin pools. */

let world: LibraryWorld;

beforeEach(async () => {
  world = await seedLibraryWorld();
  config.library.enabled = true;
  config.library.workerEnabled = false;
});

async function livePool(competencyKey: string, forms = ['star', 'opinion', 'tradeoff', 'walkthrough']) {
  const rows = [];
  for (const [i, form] of forms.entries()) rows.push(await entry(world, { competencyKey, form, difficultyTag: (i % 3) + 1 }));
  return rows;
}

function select(app: ReturnType<typeof createApp>, token: string, body: Record<string, unknown>) {
  return request(app).post('/api/library/select').set('Authorization', bearer(token)).send(body);
}

describe('with LIBRARY_ENABLED=false', () => {
  it('answers status as disabled', async () => {
    config.library.enabled = false;
    const res = await request(createApp()).get('/api/library/status');
    expect(res.body).toEqual({ enabled: false, workerEnabled: false });
  });

  it('does not mount select', async () => {
    config.library.enabled = false;
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: world.competencyKeys });
    expect(res.status).toBe(404);
  });

  it('does not mount the admin screen', async () => {
    config.library.enabled = false;
    const res = await request(createApp()).get('/api/library/admin/overview').set('Authorization', bearer(world.operator.token));
    expect(res.status).toBe(404);
  });

  it('keeps the admin screen dark even with the worker switch on', async () => {
    config.library.enabled = false;
    config.library.workerEnabled = true;
    const res = await request(createApp()).get('/api/library/admin/overview').set('Authorization', bearer(world.operator.token));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/library/select', () => {
  it('requires authentication', async () => {
    const res = await request(createApp()).post('/api/library/select').send({ roleSlug: world.roleSlug, band: BAND, competencyKeys: world.competencyKeys });
    expect(res.status).toBe(401);
  });

  it('returns a ladder for a seeded live pool', async () => {
    await livePool(world.competencyKeys[0]);
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[0]] });
    expect(res.body.ladders[world.competencyKeys[0]].length).toBe(3);
  });

  it('returns an empty ladder, not an error, for a thin pool', async () => {
    await entry(world, { competencyKey: world.competencyKeys[1] });
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[1]] });
    expect(res.body.ladders[world.competencyKeys[1]]).toEqual([]);
  });

  it('returns a snapshot with the anchors on every rung', async () => {
    await livePool(world.competencyKeys[0]);
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[0]] });
    expect(res.body.ladders[world.competencyKeys[0]][0].anchors).toEqual(['Names the failure mode', 'Says what changed after']);
  });

  it('never returns probational entries to an ordinary tenant', async () => {
    await livePool(world.competencyKeys[0], ['star', 'opinion']);
    await entry(world, { competencyKey: world.competencyKeys[0], status: 'probational', form: 'tradeoff' });
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[0]], includeProbational: true });
    expect(res.body.includeProbational).toBe(false);
  });

  it('returns probational entries to the demo sandbox when asked', async () => {
    await livePool(world.competencyKeys[0], ['star', 'opinion']);
    await entry(world, { competencyKey: world.competencyKeys[0], status: 'probational', form: 'tradeoff' });
    const res = await select(createApp(), world.demo.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[0]], includeProbational: true });
    expect(res.body.ladders[world.competencyKeys[0]].length).toBe(3);
  });

  it('keeps another organisation\'s private entries out', async () => {
    await livePool(world.competencyKeys[0], ['star', 'opinion']);
    await entry(world, { competencyKey: world.competencyKeys[0], form: 'tradeoff', scope: 'org', tenantId: world.demo.tenantId });
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[0]] });
    expect(res.body.ladders[world.competencyKeys[0]].length).toBe(2);
  });

  it('includes the caller\'s own private entries', async () => {
    await livePool(world.competencyKeys[0], ['star', 'opinion']);
    await entry(world, { competencyKey: world.competencyKeys[0], form: 'tradeoff', scope: 'org', tenantId: world.admin.tenantId });
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[0]] });
    expect(res.body.ladders[world.competencyKeys[0]].length).toBe(3);
  });

  it('does not repeat an entry this organisation asked for the role inside the window', async () => {
    const rows = await livePool(world.competencyKeys[0], ['star', 'opinion', 'tradeoff']);
    await prisma.libraryUsage.create({ data: { entryId: rows[0].id, interviewSessionId: 's1', tenantId: world.admin.tenantId, roleSlug: world.roleSlug } });
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[0]] });
    expect((res.body.ladders[world.competencyKeys[0]] as { entryId: string }[]).map((r) => r.entryId)).not.toContain(rows[0].id);
  });

  it('treats an asked grandparent as a repeat of its twice-edited descendant', async () => {
    const grandparent = await entry(world, { competencyKey: world.competencyKeys[0], form: 'star', status: 'retired' });
    const parent = await entry(world, { competencyKey: world.competencyKeys[0], form: 'star', status: 'retired', supersedesId: grandparent.id });
    const child = await entry(world, { competencyKey: world.competencyKeys[0], form: 'star', supersedesId: parent.id });
    await livePool(world.competencyKeys[0], ['opinion', 'tradeoff', 'walkthrough']);
    await prisma.libraryUsage.create({ data: { entryId: grandparent.id, interviewSessionId: 's1', tenantId: world.admin.tenantId, roleSlug: world.roleSlug } });
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[0]] });
    expect((res.body.ladders[world.competencyKeys[0]] as { entryId: string }[]).map((x) => x.entryId)).not.toContain(child.id);
  });

  it('refuses an unknown band', async () => {
    const res = await select(createApp(), world.admin.token, { roleSlug: world.roleSlug, band: 'wizard', competencyKeys: world.competencyKeys });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/library/entries/:id', () => {
  it('returns the snapshot of a live entry', async () => {
    const row = await entry(world);
    const res = await request(createApp()).get(`/api/library/entries/${row.id}`).set('Authorization', bearer(world.admin.token));
    expect(res.body.snapshot.entryId).toBe(row.id);
  });

  it('still resolves a retired entry for a transcript', async () => {
    const row = await entry(world, { status: 'retired' });
    const res = await request(createApp()).get(`/api/library/entries/${row.id}`).set('Authorization', bearer(world.admin.token));
    expect(res.body.status).toBe('retired');
  });

  it('hides drafts', async () => {
    const row = await entry(world, { status: 'draft' });
    const res = await request(createApp()).get(`/api/library/entries/${row.id}`).set('Authorization', bearer(world.admin.token));
    expect(res.status).toBe(404);
  });

  it('hides another organisation\'s private entry', async () => {
    const row = await entry(world, { scope: 'org', tenantId: world.demo.tenantId });
    const res = await request(createApp()).get(`/api/library/entries/${row.id}`).set('Authorization', bearer(world.admin.token));
    expect(res.status).toBe(404);
  });

  it('refuses a reserved id', async () => {
    const res = await request(createApp()).get('/api/library/entries/__opening__').set('Authorization', bearer(world.admin.token));
    expect(res.status).toBe(404);
  });
});
