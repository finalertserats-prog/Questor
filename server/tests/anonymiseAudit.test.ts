import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { anonymiseAfterDays, runAnonymisationSweep } from '../src/services/anonymise.js';
import { payloadRemoved } from '../src/services/auditPayloads.js';

/**
 * Taking the person out of their own audit history.
 *
 * `AuditEvent` is the one table deliberately exempt from erasure and from the
 * retention sweep — you cannot demonstrate compliance with a deletion
 * obligation whose record you also deleted. That exemption made it a blind
 * spot: `beforeJson` and `afterJson` are whatever the calling code passed, and
 * for a candidate that includes prose they typed about themselves. Anonymising
 * the interview while leaving a row beside it that quotes the candidate would
 * be the same mapping table the rest of this design exists to prevent.
 *
 * The fixture below does NOT hand-write audit rows. It drives the real portal
 * endpoint so the rows under test are the ones production writes, in the shape
 * production writes them — a test that builds its own input can only ever
 * prove that the input was built.
 */

const app = createApp();
const DAY_MS = 24 * 60 * 60 * 1000;
const longAgo = () => new Date(Date.now() - (anonymiseAfterDays() + 1) * DAY_MS);

/**
 * The sentence this whole test file is about. It names nobody, so no pattern
 * built from what Questor holds can find it, and it is exactly the kind of
 * thing the product's own code says an accommodation request may contain.
 */
const REQUEST = 'I have a hearing impairment and will need captions throughout the interview, please.';

/**
 * A candidate who asked for an accommodation on the consent screen, through the
 * real endpoint, and whose interview then finished over a year ago.
 */
async function candidateWhoAskedForAnAccommodation() {
  await wipe();
  const ids = await createDemoData();

  const consent = await request(app).post(`/api/portal/${ids.token}/consent`).send({
    accepted: true,
    recordingConsent: true,
    accommodationRequest: REQUEST,
  });
  expect(consent.status).toBe(200);

  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: { state: 'COMPLETED', completedAt: longAgo(), legalHold: false },
  });
  return ids;
}

const auditFor = (entityId: string) =>
  prisma.auditEvent.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

/**
 * The accommodation row, or a failure that says the fixture stopped writing it.
 *
 * Deliberately not `.find(...)` with `?.` at the call sites. Comparing
 * `{ id: after?.id, ... }` against `{ id: before?.id, ... }` passes when BOTH
 * sides are missing — every field is `undefined` on each, `toEqual` agrees, and
 * a test whose whole job is "the row survives" reports success having compared
 * nothing at all. Absent values silently taking part in a comparison is the
 * same shape that hid a real defect elsewhere in this repo, and it is worth a
 * loud throw to keep it out of the one test that guards "rows stay, payloads
 * go".
 */
async function accommodationRow(sessionId: string) {
  const found = (await auditFor(sessionId)).find((e) => e.action === 'accommodation.requested');
  if (!found) throw new Error('No accommodation.requested audit row: the fixture is no longer writing one.');
  return found;
}

describe('the accommodation request', () => {
  beforeEach(async () => { await wipe(); });

  it('really is written verbatim into the audit log, which is why this file exists', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    const events = await auditFor(ids.sessionId);

    expect(events.some((e) => e.action === 'accommodation.requested' && e.afterJson.includes('hearing impairment'))).toBe(true);
  });

  it('is gone from the audit log once the candidate is anonymised', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    await runAnonymisationSweep(new Date());

    const events = await auditFor(ids.sessionId);
    expect(events.map((e) => e.afterJson).join(' ')).not.toMatch(/hearing impairment/i);
  });

  it('is gone from the consent record too, where redaction could never have reached it', async () => {
    // There is no pattern for "whatever that person chose to tell us about
    // themselves", so the field is removed rather than scrubbed.
    const ids = await candidateWhoAskedForAnAccommodation();

    await runAnonymisationSweep(new Date());

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(session.consentJson).not.toMatch(/hearing impairment/i);
  });

  it('leaves behind the date one was asked for, because that is a fact about the process', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    await runAnonymisationSweep(new Date());

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect(session.consentJson).toMatch(/accommodationRequestedAt/);
  });
});

describe('what the audit log keeps', () => {
  beforeEach(async () => { await wipe(); });

  it('keeps the row itself — who acted, what they did, on what, and when', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();
    const before = await accommodationRow(ids.sessionId);

    await runAnonymisationSweep(new Date());

    const after = await accommodationRow(ids.sessionId);
    const identity = (row: typeof after) => ({
      id: row.id, actorId: row.actorId, actorType: row.actorType,
      action: row.action, entityType: row.entityType, entityId: row.entityId,
      createdAt: row.createdAt,
    });
    expect(identity(after)).toEqual(identity(before));
  });

  it('says where a payload was taken out, and which process took it', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    await runAnonymisationSweep(new Date());

    const event = await accommodationRow(ids.sessionId);
    // Anonymisation severs a person from a record that is KEPT; erasure removes
    // them entirely. A reader of the log should be able to tell which one
    // emptied a payload, so the marker names the process.
    expect(event.afterJson).toBe(payloadRemoved('anonymisation'));
  });

  it('does not invent a "before" for an action that never recorded one', async () => {
    // The marker means "something was taken out here". An empty column means
    // "this action never wrote anything". Conflating them would make the audit
    // log lie about itself in a new way while fixing the old one.
    const ids = await candidateWhoAskedForAnAccommodation();

    await runAnonymisationSweep(new Date());

    const event = await accommodationRow(ids.sessionId);
    expect(event.beforeJson).toBe('');
  });

  it('still proves the anonymisation happened', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    await runAnonymisationSweep(new Date());

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'candidate.anonymised', entityId: ids.candidateId },
    });
    expect(event.afterJson).toMatch(/anonymisation window elapsed/);
  });
});

describe('what the audit clearing must not reach', () => {
  beforeEach(async () => { await wipe(); });

  it('leaves another candidate’s history alone, even one with the same name', async () => {
    // The content net matches on the ADDRESS, never the name. Two people called
    // Priya Sharma in one organisation is ordinary, and gutting the audit
    // history of the one who is still in a live process would be a real loss
    // inflicted on the wrong person.
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

    await runAnonymisationSweep(new Date());

    const theirs = await auditFor(namesake.id);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].afterJson).toMatch(/still in process/);
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

    await runAnonymisationSweep(new Date());

    const after = await prisma.auditEvent.findUniqueOrThrow({ where: { id: unrelated.id } });
    expect(after.afterJson).toBe(unrelated.afterJson);
  });
});
