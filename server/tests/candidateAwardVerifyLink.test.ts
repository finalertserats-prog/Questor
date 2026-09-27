import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';
import { serialiseEvidence, type AwardFacts, type AwardTier } from '../src/domain/candidateAwards.js';
import { DEFAULT_STAGES } from '../src/domain/pipelineStages.js';

/**
 * Sharing a credential from the viewer.
 *
 * "Share" is the public verification link and nothing new: the token that
 * the certificate already prints under VERIFY, handed out on request so that
 * the journey list itself never carries it. The tests here are about that
 * boundary — the link is built from the token and never from the printed
 * reference, it leaves only for a caller who may see the candidate, and the
 * act is written to the trail the same way an export is.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const FACTS: AwardFacts = {
  awardedAt: new Date('2026-09-24T00:00:00.000Z'),
  candidateName: 'Priya Sharma',
  roleTitle: 'Senior Marketing Manager',
  recordedByName: 'Rahul Menon',
  candidateCreatedAt: new Date('2026-09-20T09:00:00.000Z'),
  profile: { readAt: new Date('2026-09-21T09:00:00.000Z'), scorecardVersion: 4, competenciesEvidenced: 8, competenciesTotal: 10 },
  aiInterview: { completedAt: new Date('2026-09-22T09:00:00.000Z'), minutes: 24, competencies: 10, quotedEvidence: true },
  humanReview: { at: new Date('2026-09-23T09:00:00.000Z'), reviewerName: 'Aparna Rao' },
  humanRounds: [{ completedAt: new Date('2026-09-22T09:00:00.000Z'), minutes: 48, interviewers: ['Aparna Rao'] }],
  priorAwardAt: new Date('2026-09-21T09:00:00.000Z'),
  promotedTo: 'Gold',
  promotedByName: 'Rahul Menon',
};

interface Org {
  readonly tenantId: string;
  readonly adminToken: string;
  readonly adminId: string;
  readonly candidateId: string;
  readonly roleId: string;
}

async function makeOrg(slug: string): Promise<Org> {
  const tenant = await prisma.tenant.create({ data: { name: `Org ${slug}` } });
  const admin = await prisma.user.create({
    data: { tenantId: tenant.id, email: `admin@${slug}.local`, name: 'Admin', passwordHash: 'x', role: 'admin' },
  });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: FACTS.roleTitle, status: 'approved' } });
  const candidate = await prisma.candidate.create({
    data: { tenantId: tenant.id, roleId: role.id, fullName: FACTS.candidateName, email: `${slug}@example.com` },
  });
  // The journey is read through the pipeline being shown; without one the
  // candidate is at the start of a default plan and has earned nothing.
  await prisma.candidatePipeline.create({
    data: {
      tenantId: tenant.id, candidateId: candidate.id, roleId: role.id,
      stagesJson: JSON.stringify(DEFAULT_STAGES), currentStageKey: 'gold', status: 'ACTIVE',
    },
  });
  return {
    tenantId: tenant.id,
    adminToken: signToken({ userId: admin.id, tenantId: tenant.id, role: 'admin', email: admin.email }),
    adminId: admin.id,
    candidateId: candidate.id,
    roleId: role.id,
  };
}

function award(org: Org, tier: AwardTier, reference: string, verifyToken: string) {
  return prisma.candidateAward.create({
    data: {
      tenantId: org.tenantId, candidateId: org.candidateId, roleId: org.roleId, tier,
      reference, verifyToken, evidenceJson: serialiseEvidence(tier, FACTS),
      awardedAt: new Date('2026-09-24T00:00:00.000Z'),
    },
  });
}

const link = (org: Org, tier: string, token: string) =>
  request(app).get(`/api/candidates/${org.candidateId}/awards/${tier}/verify-link`).set(auth(token));

let a: Org;
let b: Org;
let silverId = '';

beforeEach(async () => {
  await wipe();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
  a = await makeOrg('alpha');
  b = await makeOrg('beta');
  silverId = (await award(a, 'silver', 'QS-SLV-8F2K-4471', 'v-alpha-silver-random')).id;
});

describe('GET /api/candidates/:id/awards/:tier/verify-link', () => {
  it('answers the public verification link, built from the token and the web origin', async () => {
    const res = await link(a, 'silver', a.adminToken);

    expect([res.status, res.body.verifyUrl]).toEqual([200, `${config.webOrigin}/v/v-alpha-silver-random`]);
  });

  it('answers the reference beside it, so the person copying knows what they hold', async () => {
    const res = await link(a, 'silver', a.adminToken);

    expect(res.body.reference).toBe('QS-SLV-8F2K-4471');
  });

  it('never builds the link from the printed reference', async () => {
    const res = await link(a, 'silver', a.adminToken);

    expect(String(res.body.verifyUrl)).not.toContain('8F2K');
  });

  it('writes the act to the trail, the way an export is: who, in which organisation, about which award', async () => {
    await link(a, 'silver', a.adminToken);

    const trail = await prisma.auditEvent.findMany({ where: { action: 'candidate.award.verify_link_shared' } });
    expect(trail.map((row) => [row.entityId, row.tenantId, row.actorId, row.actorType])).toEqual([[silverId, a.tenantId, a.adminId, 'user']]);
  });

  it('names the tier and the reference in the trail, and nothing more', async () => {
    await link(a, 'silver', a.adminToken);

    const row = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'candidate.award.verify_link_shared' } });
    expect(JSON.parse(row.afterJson ?? '{}')).toEqual({ tier: 'silver', reference: 'QS-SLV-8F2K-4471' });
  });

  it('keeps the token itself out of the trail', async () => {
    await link(a, 'silver', a.adminToken);

    const trail = await prisma.auditEvent.findMany({ where: { action: 'candidate.award.verify_link_shared' } });
    expect(JSON.stringify(trail)).not.toContain('v-alpha-silver-random');
  });

  it('answers 404 for a tier that has not been earned', async () => {
    const res = await link(a, 'gold', a.adminToken);

    expect(res.status).toBe(404);
  });

  it('will not hand out another organisation’s link', async () => {
    const res = await link(a, 'silver', b.adminToken);

    expect([res.status, res.body.verifyUrl]).toEqual([404, undefined]);
  });

  it('refuses Diamond, which has no public page, and says so', async () => {
    await award(a, 'diamond', 'QS-DIA-5J3T-2290', 'v-alpha-diamond-random');

    const res = await link(a, 'diamond', a.adminToken);

    expect([res.status, res.body.code]).toEqual([409, 'no_public_page_for_tier']);
  });
});

describe('the journey row', () => {
  const journey = () => request(app).get(`/api/candidates/${a.candidateId}/awards`).set(auth(a.adminToken));
  const row = (body: { awards: { tier: string }[] }, tier: string) => body.awards.find((r) => r.tier === tier) as Record<string, unknown> & { exports?: Record<string, unknown> };

  it('points at the verification link beside the exports, never at the token itself', async () => {
    const res = await journey();

    const silver = row(res.body, 'silver');
    expect(silver.exports?.verifyLink).toBe(`/api/candidates/${a.candidateId}/awards/silver/verify-link`);
    expect(JSON.stringify(res.body)).not.toContain('v-alpha-silver-random');
  });

  it('carries the send path on a Silver, which an admin may release', async () => {
    const res = await journey();

    expect(row(res.body, 'silver').exports?.certificateSend).toBe(`/api/candidates/${a.candidateId}/awards/silver/certificate/send`);
  });

  it('carries no send path on Bronze, which is never issued to the candidate', async () => {
    await award(a, 'bronze', 'QS-BRZ-2D9P-1183', 'v-alpha-bronze-random');

    const res = await journey();

    expect(row(res.body, 'bronze').exports?.certificateSend).toBeNull();
  });

  it('carries no send path and no verification link on Diamond', async () => {
    await award(a, 'diamond', 'QS-DIA-5J3T-2290', 'v-alpha-diamond-random');

    const res = await journey();

    const diamond = row(res.body, 'diamond');
    expect([diamond.exports?.certificateSend, diamond.exports?.verifyLink]).toEqual([null, null]);
  });
});
