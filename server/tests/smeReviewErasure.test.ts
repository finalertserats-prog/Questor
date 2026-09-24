import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { eraseCandidate } from '../src/services/dataRights.js';

/**
 * An expert's recommendation goes when the candidate does.
 *
 * `SmeReview.feedback` is a person writing, in their own words, about a named
 * candidate — the same class of content as a human review's comments, and the
 * kind of thing an erasure request is about.
 *
 * The reason this needs its own file rather than a line in the erasure suite is
 * how it would fail. `SmeReview` holds no foreign key onto `Candidate` (the
 * model is keyed by id alone, as the contract defines it), so the candidate row
 * deletes perfectly happily with the review still sitting there. Nothing errors,
 * nothing is logged, and `eraseCandidate` returns success. An erasure that
 * reports done while a paragraph naming the person remains in the database is
 * the worst shape this obligation can fail in, and the only thing that can
 * notice is a test that goes and looks.
 */

let tenantId = '';
let roleId = '';
let scorecardId = '';
let smeUserId = '';

beforeEach(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Erasure Org' } });
  tenantId = tenant.id;
  const role = await prisma.role.create({ data: { tenantId, title: 'Staff Engineer', status: 'approved' } });
  roleId = role.id;
  scorecardId = (await prisma.roleScorecardVersion.create({
    data: { roleId, version: 1, status: 'approved', profileJson: '{}' },
  })).id;
  smeUserId = (await prisma.user.create({
    data: { tenantId, email: 'expert@erasure.test', name: 'Expert', passwordHash: 'x', role: 'sme' },
  })).id;
});

async function candidateWithReview(sessionId: string | null) {
  const candidate = await prisma.candidate.create({
    data: { tenantId, roleId, fullName: 'Leena Kapoor', email: 'leena@erasure.test', emailNormalized: 'leena@erasure.test' },
  });
  await prisma.smeReview.create({
    data: {
      tenantId, candidateId: candidate.id, roleId, sessionId, smeUserId,
      recommendation: 'proceed',
      feedback: 'Leena talked through the failure modes of her own design before I asked about them.',
    },
  });
  return candidate;
}

const erase = (candidateId: string) => eraseCandidate({
  tenantId, candidateId, actorId: smeUserId, reason: 'The candidate asked to be forgotten.',
});

describe('erasing a candidate', () => {
  it('removes an expert recommendation written about an interview', async () => {
    const candidate = await candidateWithReview(null);
    const session = await prisma.interviewSession.create({
      data: { tenantId, candidateId: candidate.id, roleId, scorecardId, state: 'COMPLETED' },
    });
    await prisma.smeReview.updateMany({ where: { candidateId: candidate.id }, data: { sessionId: session.id } });

    await erase(candidate.id);

    expect(await prisma.smeReview.count({ where: { candidateId: candidate.id } })).toBe(0);
  });

  // The case the session cascade cannot reach: an expert asked to read a CV
  // against the role before anybody interviewed the candidate. It is the same
  // personal data and it is attached to nothing that gets deleted on its own.
  it('removes one written before any interview existed', async () => {
    const candidate = await candidateWithReview(null);

    await erase(candidate.id);

    expect(await prisma.smeReview.count({ where: { candidateId: candidate.id } })).toBe(0);
  });

  it('leaves another candidate\'s recommendation standing', async () => {
    const erased = await candidateWithReview(null);
    const other = await prisma.candidate.create({
      data: { tenantId, roleId, fullName: 'Not Them', email: 'other@erasure.test', emailNormalized: 'other@erasure.test' },
    });
    await prisma.smeReview.create({
      data: { tenantId, candidateId: other.id, roleId, smeUserId, recommendation: 'do_not_proceed', feedback: 'A different person entirely, and a different reading.' },
    });

    await erase(erased.id);

    expect(await prisma.smeReview.count({ where: { candidateId: other.id } })).toBe(1);
  });

  it('counts what it removed, so the erasure record is not silently short', async () => {
    const candidate = await candidateWithReview(null);

    const result = await erase(candidate.id);

    expect(result.deleted.smeReviews).toBe(1);
  });
});

describe('purging an interview past its retention window', () => {
  it('takes an expert recommendation about that interview with it', async () => {
    const candidate = await candidateWithReview(null);
    const session = await prisma.interviewSession.create({
      data: { tenantId, candidateId: candidate.id, roleId, scorecardId, state: 'COMPLETED', retainUntil: new Date(Date.now() - 86_400_000) },
    });
    await prisma.smeReview.updateMany({ where: { candidateId: candidate.id }, data: { sessionId: session.id } });

    const { runRetentionSweep } = await import('../src/services/dataRights.js');
    await runRetentionSweep();

    expect(await prisma.smeReview.count({ where: { candidateId: candidate.id } })).toBe(0);
  });

  // A reading of the CV against the role is not about the interview, so a
  // purge of the interview does not silently take the hiring team's advice
  // away while the candidate is still live.
  it('leaves a recommendation that is not about an interview', async () => {
    const candidate = await candidateWithReview(null);
    await prisma.interviewSession.create({
      data: { tenantId, candidateId: candidate.id, roleId, scorecardId, state: 'COMPLETED', retainUntil: new Date(Date.now() - 86_400_000) },
    });

    const { runRetentionSweep } = await import('../src/services/dataRights.js');
    await runRetentionSweep();

    expect(await prisma.smeReview.count({ where: { candidateId: candidate.id } })).toBe(1);
  });
});
