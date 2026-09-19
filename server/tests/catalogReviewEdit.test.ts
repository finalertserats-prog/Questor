import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { bearer, proposal, seedReviewWorld, type ReviewWorld } from './catalogReviewFixtures.js';

/** Editing a proposal before the decision, with every id checked against the live catalog. */

const app = createApp();
let world: ReviewWorld;

beforeEach(async () => {
  world = await seedReviewWorld();
});

function edit(id: string, body: object) {
  return request(app).patch(`/api/catalog-review/proposals/${id}`).set('Authorization', bearer(world.operator.token)).send(body);
}

async function stored(id: string) {
  return prisma.catalogProposal.findUniqueOrThrow({ where: { id } });
}

describe('editing a new-role proposal', () => {
  it('changes the title and recomputes its normalised form', async () => {
    const p = await proposal(world, { title: 'Agent Reliabilty Engineer' });
    const res = await edit(p.id, { title: '  Agent Reliability Engineer ' });
    const row = await stored(p.id);
    expect({ status: res.status, title: row.title, normalized: row.normalizedTitle, returned: res.body.proposal.title }).toEqual({ status: 200, title: 'Agent Reliability Engineer', normalized: 'agent reliability engineer', returned: 'Agent Reliability Engineer' });
  });

  it('refuses a title the shared catalog must not hold', async () => {
    const p = await proposal(world, { title: 'Agent Reliability Engineer' });
    const res = await edit(p.id, { title: 'Email jobs@acme.test' });
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 400, error: 'Title must not contain contact details or links.' });
  });

  it('sets a domain and a family used in it', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse', domainId: null });
    await edit(p.id, { domainId: world.catalog.healthId, familyId: world.catalog.careFamilyId });
    const row = await stored(p.id);
    expect({ domainId: row.domainId, familyId: row.familyId }).toEqual({ domainId: world.catalog.healthId, familyId: world.catalog.careFamilyId });
  });

  it('refuses a family that is not used in the domain', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse' });
    expect((await edit(p.id, { familyId: world.catalog.careFamilyId })).status).toBe(400);
  });

  it('refuses a domain that does not exist', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse' });
    expect((await edit(p.id, { domainId: 'cjld2cjxh0000qzrmn831i7rn' })).status).toBe(400);
  });

  it('refuses an inactive domain', async () => {
    await prisma.catalogDomain.update({ where: { id: world.catalog.healthId }, data: { status: 'retired' } });
    const p = await proposal(world, { title: 'Wound Care Nurse' });
    expect((await edit(p.id, { domainId: world.catalog.healthId })).status).toBe(400);
  });

  it('clears a family that no longer fits the new domain', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse', familyId: world.catalog.engFamilyId });
    await edit(p.id, { domainId: world.catalog.healthId });
    expect((await stored(p.id)).familyId).toBeNull();
  });

  it('refuses a malformed id', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse' });
    expect((await edit(p.id, { domainId: 'not-an-id' })).status).toBe(400);
  });

  it('refuses a target role on a new role', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse' });
    expect((await edit(p.id, { targetRoleId: world.catalog.nurseId })).status).toBe(400);
  });

  it('updates the summary', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse' });
    await edit(p.id, { summary: 'Treats chronic wounds.' });
    expect((await stored(p.id)).summary).toBe('Treats chronic wounds.');
  });

  it('refuses unknown fields', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse' });
    expect((await edit(p.id, { status: 'approved' })).status).toBe(400);
  });

  it('refuses an empty edit', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse' });
    expect((await edit(p.id, {})).status).toBe(400);
  });

  it('refuses to edit a proposal that is no longer pending', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse', status: 'approved' });
    expect((await edit(p.id, { title: 'Other' })).status).toBe(409);
  });

  it('answers 404 for an unknown proposal', async () => {
    expect((await edit('cjld2cjxh0000qzrmn831i7rn', { title: 'Other title' })).status).toBe(404);
  });

  it('records the edit in the audit log', async () => {
    const p = await proposal(world, { title: 'Wound Care Nurse' });
    await edit(p.id, { title: 'Wound Care Specialist' });
    expect((await prisma.auditEvent.findMany({ where: { entityId: p.id } })).map((e) => e.action)).toEqual(['catalog.proposal.edited']);
  });
});

describe('editing an alternative-title proposal', () => {
  it('moves it to another active role and takes that role\'s domain', async () => {
    const p = await proposal(world, { kind: 'new_alias', title: 'Staff Nurse' });
    await edit(p.id, { targetRoleId: world.catalog.nurseId });
    const row = await stored(p.id);
    expect({ target: row.targetRoleId, domainId: row.domainId }).toEqual({ target: world.catalog.nurseId, domainId: world.catalog.healthId });
  });

  it('refuses an inactive role', async () => {
    await prisma.catalogRole.update({ where: { id: world.catalog.nurseId }, data: { status: 'retired' } });
    const p = await proposal(world, { kind: 'new_alias', title: 'Staff Nurse' });
    expect((await edit(p.id, { targetRoleId: world.catalog.nurseId })).status).toBe(400);
  });

  it('refuses a domain change', async () => {
    const p = await proposal(world, { kind: 'new_alias', title: 'Staff Nurse' });
    expect((await edit(p.id, { domainId: world.catalog.healthId })).status).toBe(400);
  });
});
