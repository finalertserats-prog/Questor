import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { eraseCandidate } from '../src/services/dataRights.js';
import { PAYLOAD_REMOVED } from '../src/services/auditPayloads.js';

/**
 * The parts of erasure's audit clearing that erasureClearsAuditPayloads.test.ts
 * does not cover.
 *
 * That file already proves the core: the disclosure goes, the rows stay, a
 * cleared payload is marked as cleared rather than as never written, and the
 * erasure records itself. This one covers the content backstop that anonymisation
 * added to the shared module afterwards — what it reaches, what it must not
 * reach, and what happens when a legal hold says no.
 *
 * The fixture drives the real portal endpoint rather than writing audit rows by
 * hand, so the row under test is the one production writes.
 */

const app = createApp();
const REQUEST = 'I have a hearing impairment and will need captions throughout the interview, please.';

async function candidateWhoAskedForAnAccommodation() {
  await wipe();
  const ids = await createDemoData();
  const consent = await request(app).post(`/api/portal/${ids.token}/consent`).send({
    accepted: true, recordingConsent: true, accommodationRequest: REQUEST,
  });
  expect(consent.status).toBe(200);
  return ids;
}

const erase = (ids: { tenantId: string; candidateId: string; userId: string }) =>
  eraseCandidate({ tenantId: ids.tenantId, candidateId: ids.candidateId, actorId: ids.userId, reason: 'candidate asked' });

describe('the content backstop under erasure', () => {
  beforeEach(async () => { await wipe(); });

  it('reaches a row filed against an entity the id pass cannot enumerate', async () => {
    // The id pass finds rows by the id of the thing they are about. A row filed
    // under something we never listed is invisible to it, and this is the only
    // thing that catches one.
    const ids = await candidateWhoAskedForAnAccommodation();
    const stray = await prisma.auditEvent.create({
      data: {
        tenantId: ids.tenantId, actorId: 'system', actorType: 'system',
        action: 'integration.pushed', entityType: 'SomethingWeNeverListed', entityId: 'external-42',
        afterJson: JSON.stringify({ to: 'priya.sharma@example.com' }),
      },
    });

    await erase(ids);

    const after = await prisma.auditEvent.findUniqueOrThrow({ where: { id: stray.id } });
    expect(after.afterJson).toBe(PAYLOAD_REMOVED);
  });

  it('matches the address however it was capitalised', async () => {
    // Prisma's `contains` is case-sensitive on Postgres and `mode:
    // "insensitive"` is unavailable to a client generated for sqlite, so the
    // spellings are emitted rather than the comparison relaxed.
    const ids = await candidateWhoAskedForAnAccommodation();
    const shouty = await prisma.auditEvent.create({
      data: {
        tenantId: ids.tenantId, actorId: 'system', actorType: 'system',
        action: 'integration.pushed', entityType: 'SomethingWeNeverListed', entityId: 'external-43',
        afterJson: JSON.stringify({ to: 'PRIYA.SHARMA@EXAMPLE.COM' }),
      },
    });

    await erase(ids);

    expect((await prisma.auditEvent.findUniqueOrThrow({ where: { id: shouty.id } })).afterJson).toBe(PAYLOAD_REMOVED);
  });

  it('leaves another candidate’s history alone, even one with the same name', async () => {
    // The net matches on the ADDRESS, never the name — which is why
    // `IdentityHandles` cannot carry one. Two people called Priya Sharma in one
    // organisation is ordinary, and gutting the history of the one still in a
    // live process would be harm done to the wrong person.
    const ids = await candidateWhoAskedForAnAccommodation();
    const namesake = await prisma.candidate.create({
      data: {
        tenantId: ids.tenantId, roleId: ids.roleId, fullName: 'Priya Sharma',
        email: 'priya.sharma+2@example.com', emailNormalized: 'priya.sharma+2@example.com',
      },
    });
    await prisma.auditEvent.create({
      data: {
        tenantId: ids.tenantId, actorId: 'recruiter', actorType: 'user',
        action: 'candidate.created', entityType: 'Candidate', entityId: namesake.id,
        afterJson: JSON.stringify({ note: 'a different Priya Sharma, still in process' }),
      },
    });

    await erase(ids);

    const theirs = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: namesake.id } });
    expect(theirs.afterJson).toMatch(/still in process/);
  });

  it('leaves the rest of the organisation’s audit log alone', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();
    const unrelated = await prisma.auditEvent.create({
      data: {
        tenantId: ids.tenantId, actorId: ids.userId, actorType: 'user',
        action: 'role.published', entityType: 'Role', entityId: ids.roleId,
        afterJson: JSON.stringify({ status: 'approved' }),
      },
    });

    await erase(ids);

    expect((await prisma.auditEvent.findUniqueOrThrow({ where: { id: unrelated.id } })).afterJson)
      .toBe(unrelated.afterJson);
  });
});

describe('erasure reports and refuses', () => {
  beforeEach(async () => { await wipe(); });

  it('reports how many payloads it cleared, so the count reaches whoever ordered the erasure', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    const result = await erase(ids);

    expect(result.deleted.auditPayloads).toBeGreaterThan(0);
  });

  it('is refused outright while a legal hold is in place, clearing nothing', async () => {
    // The clearing sits INSIDE the hold guard, not around it: a hold means the
    // data is evidence, and quietly stripping the payloads out of evidence
    // while refusing the erasure would be the worst of both.
    const ids = await candidateWhoAskedForAnAccommodation();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { legalHold: true } });

    await expect(erase(ids)).rejects.toMatchObject({ status: 409 });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'accommodation.requested', entityId: ids.sessionId },
    });
    expect(event.afterJson).toMatch(/hearing impairment/);
  });
});
