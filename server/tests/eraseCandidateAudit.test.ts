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

describe('a row matched only by its content', () => {
  beforeEach(async () => { await wipe(); });

  /** A row belonging to somebody else, whose payload happens to mention Priya. */
  async function anotherCandidatesRow(tenantId: string, afterJson: string) {
    return prisma.auditEvent.create({
      data: {
        tenantId, actorId: 'reviewer', actorType: 'user',
        action: 'review.completed', entityType: 'AssessmentVersion',
        entityId: 'another-candidates-assessment', afterJson,
      },
    });
  }

  it('keeps what it says about the candidate it actually belongs to', async () => {
    // THE DEFECT THIS TEST EXISTS FOR, and it shipped. A content match is not
    // proof of ownership: candidate B's own review row, whose payload compares
    // their answer to Priya's, was having its entire payload emptied when Priya
    // was erased - a record destroyed for somebody who asked for nothing.
    const ids = await candidateWhoAskedForAnAccommodation();
    const theirs = await anotherCandidatesRow(ids.tenantId, JSON.stringify({
      reason: 'Compared with priya.sharma@example.com, this answer was stronger on indexing',
    }));

    await erase(ids);

    const after = (await prisma.auditEvent.findUniqueOrThrow({ where: { id: theirs.id } })).afterJson;
    expect(after).not.toBe(PAYLOAD_REMOVED);
    expect(after).toMatch(/this answer was stronger on indexing/);
  });

  it('loses the erased candidate address from it, because nobody else has that', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();
    const theirs = await anotherCandidatesRow(ids.tenantId, JSON.stringify({
      reason: 'Compared with priya.sharma@example.com, this answer was stronger on indexing',
    }));

    await erase(ids);

    expect((await prisma.auditEvent.findUniqueOrThrow({ where: { id: theirs.id } })).afterJson)
      .toBe(JSON.stringify({ reason: 'Compared with [email], this answer was stronger on indexing' }));
  });

  it.each([
    ['all caps', 'PRIYA.SHARMA@EXAMPLE.COM'],
    ['the mixed case a person actually types', 'Priya.Sharma@Example.com'],
    ['as stored', 'priya.sharma@example.com'],
  ])('finds the address written in %s', async (_label, written) => {
    // Prisma contains is case-sensitive on Postgres, so the match is done in
    // SQL with lower() on both sides. Case variants covered the two ends and
    // missed the middle, which is the spelling a person types at signup.
    const ids = await candidateWhoAskedForAnAccommodation();
    const theirs = await anotherCandidatesRow(ids.tenantId, JSON.stringify({ to: written }));

    await erase(ids);

    expect((await prisma.auditEvent.findUniqueOrThrow({ where: { id: theirs.id } })).afterJson)
      .toBe(JSON.stringify({ to: '[email]' }));
  });

  it('leaves another candidate history alone when it never mentioned this one', async () => {
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

  it('leaves the rest of the organisation audit log alone', async () => {
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

/**
 * The two rows that put a candidate into the audit trail in the first place.
 *
 * Both are filed under a session id, so both are PROVABLY the candidate's and
 * both must be CLEARED rather than merely redacted. That distinction is the
 * whole lane: a redacted payload keeps whatever prose surrounded the handle,
 * and for the accommodation row that prose is a health disclosure the
 * candidate was told had gone.
 *
 * The ownership rule now decides clear-versus-redact, so this is the property
 * most at risk from that change and the one least visible if it broke — the
 * "no trace of the candidate anywhere" assertions pass either way, because
 * redaction removes the handle too.
 */
describe('the rows that leak a candidate are cleared, not redacted', () => {
  beforeEach(async () => { await wipe(); });

  it('clears the accommodation request, prose and all', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();

    await erase(ids);

    const row = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: ids.sessionId, action: 'accommodation.requested' },
    });
    expect(row.afterJson).toBe(PAYLOAD_REMOVED);
  });

  it('clears a failed identity-code send, whose provider error quotes the address', async () => {
    // Shape taken from services/identityCode.ts, which audits the mail
    // provider's raw error - and an SMTP rejection routinely quotes the
    // recipient it refused. Filed under the session id, so ownership is proven
    // and the payload goes rather than being redacted down to "[email]".
    const ids = await candidateWhoAskedForAnAccommodation();
    const bounced = await prisma.auditEvent.create({
      data: {
        tenantId: ids.tenantId, actorId: 'system', actorType: 'system',
        action: 'identity.code_send_failed', entityType: 'InterviewSession',
        entityId: ids.sessionId,
        afterJson: JSON.stringify({
          channel: 'email',
          detail: '550 5.1.1 <priya.sharma@example.com> recipient rejected',
        }),
      },
    });

    await erase(ids);

    const row = await prisma.auditEvent.findUniqueOrThrow({ where: { id: bounced.id } });
    expect(row.afterJson).toBe(PAYLOAD_REMOVED);
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

/**
 * Rows shared with other candidates.
 *
 * Clearing one would destroy everybody else's record to satisfy one person, so
 * they are left in place — but a handle belongs to exactly one person, so
 * taking that out costs nobody anything. An earlier version of this lane said
 * nothing could be done here, and that was too strong.
 */
describe('audit rows that belong to many candidates at once', () => {
  beforeEach(async () => { await wipe(); });

  async function sharedRow(tenantId: string, afterJson: string) {
    return prisma.auditEvent.create({
      data: {
        tenantId, actorId: 'approver', actorType: 'user',
        action: 'calibration.anchor_decided', entityType: 'CalibrationAnchorProposal',
        entityId: 'anchor-1', afterJson,
      },
    });
  }

  it('loses this candidate address and profile, and keeps the phone', async () => {
    // The phone stays because a number is not always one person's - a
    // household's, an agency switchboard, a reception desk. Removing it from a
    // row that covers other candidates would damage their record to satisfy
    // this one's timer, which is what the unowned-row rule exists to prevent.
    const ids = await candidateWhoAskedForAnAccommodation();
    await prisma.candidate.update({
      where: { id: ids.candidateId },
      data: { phone: '+91 98765 43210', linkedinUrl: 'https://www.linkedin.com/in/priya-sharma-4417' },
    });
    const row = await sharedRow(ids.tenantId, JSON.stringify({
      reason: 'declining: chased priya.sharma@example.com on 9876543210, see linkedin.com/in/priya-sharma-4417',
    }));

    await erase(ids);

    const after = (await prisma.auditEvent.findUniqueOrThrow({ where: { id: row.id } })).afterJson;
    expect(after).toBe(JSON.stringify({ reason: 'declining: chased [email] on 9876543210, see [link]' }));
  });

  it('keeps the row, and keeps what it says about everybody else', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();
    const row = await sharedRow(ids.tenantId, JSON.stringify({
      reason: 'applied: three reviewers agreed this anchor describes a strong answer',
    }));

    await erase(ids);

    const after = await prisma.auditEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.afterJson).toBe(row.afterJson);
  });

  it('leaves the name, because the row is not this candidate’s to edit', async () => {
    // Catching a name here means matching name parts, and matching name parts
    // in shared text mangles everyone else's record — "grace under pressure" is
    // not a candidate called Grace. The residual says so rather than pretending
    // otherwise.
    const ids = await candidateWhoAskedForAnAccommodation();
    const row = await sharedRow(ids.tenantId, JSON.stringify({ reason: 'declining: came from the Priya Sharma interview' }));

    await erase(ids);

    expect((await prisma.auditEvent.findUniqueOrThrow({ where: { id: row.id } })).afterJson).toBe(row.afterJson);
  });

  it('reports how many unowned rows it touched, separately from the ones it cleared', async () => {
    const ids = await candidateWhoAskedForAnAccommodation();
    await sharedRow(ids.tenantId, JSON.stringify({ reason: 'chased priya.sharma@example.com' }));

    const result = await erase(ids);

    expect(result.deleted.unownedAuditHandles).toBe(1);
  });
});
