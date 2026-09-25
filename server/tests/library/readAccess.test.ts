import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { prisma } from '../../src/db.js';
import { signToken } from '../../src/services/auth.js';
import { ROLES, DEMO_ROLE } from '../../src/domain/capabilities.js';
import { bearer, entry, seedLibraryWorld, type LibraryWorld } from './libraryFixtures.js';

/**
 * S3: the library's tenant-facing read API had no capability check.
 *
 * `POST /api/library/select` and `GET /api/library/entries/:id` sat behind
 * `authenticate` and a tenant-keyed rate limit and nothing else, so an
 * `auditor` — whose only grant is `audit:read`, described as "sees that things
 * happened, not candidate detail" — got a 200 with live interview question
 * ladders. Nothing leaked while the pool was empty; the library is now switched
 * on in production (docs/qa/resilience-2026-09-23.md, S3).
 *
 * Every role is exercised, so a capability added to a role later cannot widen
 * this quietly.
 */

// The flag is read when the app is built.
config.library.enabled = true;
const app = createApp();

let world: LibraryWorld;
let liveEntryId = '';
let otherTenantEntryId = '';
const tokens = new Map<string, string>();

/** Who may plan an interview, and so ask the library for a ladder. */
const MAY_SELECT = new Set(['recruiter', 'manager', 'admin', DEMO_ROLE]);
/** Who may read an interview, and so resolve a question one of them asked. */
const MAY_READ_ENTRY = new Set(['recruiter', 'manager', 'admin', 'reviewer', DEMO_ROLE]);

const EVERY_ROLE = [...ROLES, DEMO_ROLE];

beforeAll(async () => {
  world = await seedLibraryWorld();
  const live = await entry(world, { competencyKey: world.competencyKeys[0], status: 'live' });
  liveEntryId = live.id;
  // Another organisation's own entry: nobody here may resolve it.
  const otherTenant = await prisma.tenant.create({ data: { name: 'Someone else Ltd' } });
  const theirs = await entry(world, { scope: 'org', tenantId: otherTenant.id, status: 'live' });
  otherTenantEntryId = theirs.id;

  for (const role of EVERY_ROLE) {
    const email = `${role}@library.test`;
    const user = await prisma.user.create({
      data: { tenantId: world.admin.tenantId, email, name: email, passwordHash: 'x', role },
    });
    tokens.set(role, signToken({ userId: user.id, tenantId: world.admin.tenantId, role, email }));
  }
});

beforeEach(() => {
  config.library.enabled = true;
});

const select = (role: string) => request(app)
  .post('/api/library/select')
  .set('Authorization', bearer(tokens.get(role)!))
  .send({ roleSlug: world.roleSlug, band: 'established', competencyKeys: [world.competencyKeys[0]] });

const readEntry = (role: string, id = liveEntryId) => request(app)
  .get(`/api/library/entries/${id}`)
  .set('Authorization', bearer(tokens.get(role)!));

describe('POST /api/library/select', () => {
  it.each(EVERY_ROLE)('answers %s according to its capabilities', async (role) => {
    const res = await select(role);
    expect({ role, status: res.status }).toEqual({ role, status: MAY_SELECT.has(role) ? 200 : 403 });
  });

  it('refuses the auditor by name — the case that was found open', async () => {
    const res = await select('auditor');
    expect([res.status, res.body.ladders]).toEqual([403, undefined]);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).post('/api/library/select').send({ roleSlug: world.roleSlug, band: 'established', competencyKeys: ['x'] });
    expect(res.status).toBe(401);
  });

  it('refuses before it reads anything, so nothing is disclosed by the shape of the answer', async () => {
    const res = await select('auditor');
    expect(res.body.error).toBe('Your account does not have permission to do that.');
  });
});

describe('GET /api/library/entries/:id', () => {
  it.each(EVERY_ROLE)('answers %s according to its capabilities', async (role) => {
    const res = await readEntry(role);
    expect({ role, status: res.status }).toEqual({ role, status: MAY_READ_ENTRY.has(role) ? 200 : 403 });
  });

  it('lets a reviewer resolve a question a transcript asked', async () => {
    expect((await readEntry('reviewer')).body.snapshot.entryId).toBe(liveEntryId);
  });

  it('refuses the auditor', async () => {
    expect((await readEntry('auditor')).status).toBe(403);
  });

  it('keeps another organisation entry out of reach, even for an admin', async () => {
    expect((await readEntry('admin', otherTenantEntryId)).status).toBe(404);
  });

  it('answers the same for an entry that is not theirs and one that does not exist', async () => {
    const theirs = await readEntry('admin', otherTenantEntryId);
    const nothing = await readEntry('admin', 'no-such-entry-id');
    expect([theirs.status, theirs.body.error]).toEqual([nothing.status, nothing.body.error]);
  });
});

describe('the capability check runs before the object lookup', () => {
  it('gives the auditor the same refusal for a real id and a made-up one', async () => {
    const real = await readEntry('auditor', liveEntryId);
    const fake = await readEntry('auditor', 'no-such-entry-id');
    expect([real.status, real.body.error]).toEqual([fake.status, fake.body.error]);
  });
});
