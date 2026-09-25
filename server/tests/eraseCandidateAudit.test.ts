import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { eraseCandidate } from '../src/services/dataRights.js';
import { AUDIT_PAYLOAD_REMOVED } from '../src/services/anonymiseCascade.js';

/**
 * Erasure and the audit trail.
 *
 * The header of dataRights.ts exempted the audit trail from erasure on the
 * grounds that it "holds no personal data itself". It does. `afterJson` is
 * whatever the calling code passed, and the portal passes an accommodation
 * request verbatim — prose the product's own code says can describe a health
 * condition.
 *
 * So the strongest promise the product makes was the one that did not hold: a
 * candidate exercising their right to erasure was told they were gone, and
 * their health disclosure stayed. The rows still survive, because you cannot
 * demonstrate compliance with a deletion whose record you also deleted. The
 * payloads do not.
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

describe('erasing a candidate who disclosed something about themselves', () => {
  beforeEach(async () => { await wipe(); });

  it('used to leave the disclosure in the audit log — this is the row it was in', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    const events = await prisma.auditEvent.findMany({ where: { entityId: ids.sessionId } });

    expect(events.some((e) => e.action === 'accommodation.requested' && e.afterJson.includes('hearing impairment'))).toBe(true);
  });

  it('takes it out', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    await erase(ids);

    const everything = await prisma.auditEvent.findMany();
    expect(everything.map((e) => `${e.beforeJson} ${e.afterJson}`).join(' ')).not.toMatch(/hearing impairment/i);
  });

  it('keeps the row, so the erasure can still be demonstrated', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    await erase(ids);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'accommodation.requested', entityId: ids.sessionId },
    });
    expect({ actorId: event.actorId, entityType: event.entityType, payload: event.afterJson })
      .toEqual({ actorId: 'candidate', entityType: 'InterviewSession', payload: AUDIT_PAYLOAD_REMOVED });
  });

  it('still records that the erasure happened, with its counts', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    await erase(ids);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'candidate.erased', entityId: ids.candidateId },
    });
    // Written after the transaction by eraseCandidate, so the clearing inside
    // it cannot reach this row — which is the one row that proves the rest.
    expect(event.afterJson).toMatch(/"deleted"/);
  });

  it('reports what it cleared, so the count is visible to whoever ordered the erasure', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    const result = await erase(ids);

    expect(result.deleted.auditAfter).toBeGreaterThan(0);
  });
});

describe('what erasure’s audit clearing must not reach', () => {
  beforeEach(async () => { await wipe(); });

  it('leaves another candidate’s history alone, even one with the same name', async () => {
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
