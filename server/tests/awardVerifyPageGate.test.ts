import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { signToken } from '../src/services/auth.js';
import { serialiseEvidence, type AwardFacts } from '../src/domain/candidateAwards.js';
import { DEFAULT_STAGES } from '../src/domain/pipelineStages.js';

/**
 * The public verification page is not on this deployment yet.
 *
 * The in-app viewer previews and downloads a badge or a certificate from bytes
 * we already hold, and that works with or without the page. Two of its actions
 * do not: "copy verification link" and "send to candidate" both hand somebody
 * a `/v/<token>` URL, and until that page is deployed the URL is a 404.
 *
 * Emailing one to a candidate is the case that cannot be undone. They are told
 * their credential is ready, they follow the link, and it is not there — and
 * nothing in this product pushes an alert, so nobody finds out from our side.
 *
 * So the paths stop being offered AND the routes refuse. A hidden button is
 * not a closed door: a stale tab, a saved request or a script still knows the
 * URL.
 */

const app = createApp();

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

async function silverAward() {
  const tenant = await prisma.tenant.create({ data: { name: 'Gate Org' } });
  const admin = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'admin@gate.local', name: 'Admin', passwordHash: 'x', role: 'admin' },
  });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
  const candidate = await prisma.candidate.create({
    data: { tenantId: tenant.id, roleId: role.id, fullName: 'Meera Iyer', email: 'meera@gate.local' },
  });
  // The award rows are built from the candidate's journey, so without a
  // pipeline the list comes back EMPTY and every assertion below would pass by
  // finding nothing — which is the failure mode these tests exist to catch.
  await prisma.candidatePipeline.create({
    data: {
      tenantId: tenant.id, candidateId: candidate.id, roleId: role.id,
      stagesJson: JSON.stringify(DEFAULT_STAGES), currentStageKey: 'gold', status: 'ACTIVE',
    },
  });
  await prisma.candidateAward.create({
    data: {
      tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, tier: 'silver',
      reference: 'QS-SLV-8F2K-4471', verifyToken: 'v-gate-silver-token',
      evidenceJson: serialiseEvidence('silver', FACTS),
      awardedAt: new Date('2026-09-24T00:00:00.000Z'),
    },
  });
  return {
    candidateId: candidate.id,
    token: signToken({ userId: admin.id, tenantId: tenant.id, role: 'admin', email: admin.email }),
  };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const original = config.awards.publicVerifyPage;

beforeEach(async () => {
  await wipe();
});

afterEach(() => {
  config.awards.publicVerifyPage = original;
});

describe('while the public verification page is not deployed', () => {
  beforeEach(() => { config.awards.publicVerifyPage = false; });

  it('offers no verification link on the award row, so no button is drawn', async () => {
    const { candidateId, token } = await silverAward();

    const res = await request(app).get(`/api/candidates/${candidateId}/awards`).set(auth(token));

    const silver = res.body.awards.find((a: { tier: string }) => a.tier === 'silver');
    // `earned` first, so a missing row fails loudly instead of passing by
    // being absent. `??` is deliberately not used on the value under test —
    // null is the answer we want, and a nullish default would swallow it.
    expect([Boolean(silver?.earned), Boolean(silver?.exports), silver?.exports?.verifyLink])
      .toEqual([true, true, null]);
  });

  it('offers no send path either', async () => {
    const { candidateId, token } = await silverAward();

    const res = await request(app).get(`/api/candidates/${candidateId}/awards`).set(auth(token));

    const silver = res.body.awards.find((a: { tier: string }) => a.tier === 'silver');
    expect([Boolean(silver?.earned), Boolean(silver?.exports), silver?.exports?.certificateSend])
      .toEqual([true, true, null]);
  });

  it('refuses the verification link even when the URL is already known', async () => {
    const { candidateId, token } = await silverAward();

    const res = await request(app).get(`/api/candidates/${candidateId}/awards/silver/verify-link`).set(auth(token));

    expect([res.status, res.body.code]).toEqual([409, 'public_verify_page_unavailable']);
  });

  it('refuses to email a candidate a link to a page that is not there', async () => {
    // The one that cannot be undone.
    const { candidateId, token } = await silverAward();

    const res = await request(app).post(`/api/candidates/${candidateId}/awards/silver/certificate/send`).set(auth(token));

    expect([res.status, res.body.code]).toEqual([409, 'public_verify_page_unavailable']);
  });

  it('records nothing as sent when the send was refused', async () => {
    // A refusal that still stamped the award would make the certificate
    // unsendable for ever once the page does go live.
    const { candidateId, token } = await silverAward();

    await request(app).post(`/api/candidates/${candidateId}/awards/silver/certificate/send`).set(auth(token));

    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'silver' } });
    expect(award.sentToCandidateAt).toBeNull();
  });

  it('still serves the certificate itself, which needs no public page', async () => {
    // The viewer's whole purpose. These are bytes we already hold.
    const { candidateId, token } = await silverAward();

    const res = await request(app).get(`/api/candidates/${candidateId}/awards/silver/certificate.pdf`).set(auth(token));

    expect([res.status, res.headers['content-type']]).toEqual([200, 'application/pdf']);
  });

  it('still serves the badge', async () => {
    const { candidateId, token } = await silverAward();

    const res = await request(app).get(`/api/candidates/${candidateId}/awards/silver/badge.svg`).set(auth(token));

    expect(res.status).toBe(200);
  });
});

describe('once the public verification page is deployed', () => {
  beforeEach(() => { config.awards.publicVerifyPage = true; });

  it('offers the verification link again', async () => {
    const { candidateId, token } = await silverAward();

    const res = await request(app).get(`/api/candidates/${candidateId}/awards`).set(auth(token));

    const silver = res.body.awards.find((a: { tier: string }) => a.tier === 'silver');
    expect(silver.exports.verifyLink).toContain('/verify-link');
  });

  it('gives out a link when asked', async () => {
    const { candidateId, token } = await silverAward();

    const res = await request(app).get(`/api/candidates/${candidateId}/awards/silver/verify-link`).set(auth(token));

    expect([res.status, typeof res.body.verifyUrl]).toEqual([200, 'string']);
  });
});
