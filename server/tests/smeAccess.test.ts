import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';

/**
 * The subject-matter expert's access, written against the HTTP surface.
 *
 * Against HTTP rather than against `capabilitiesOf` directly, for the reason
 * accessAdmin.test.ts gives: a unit test of the capability map would still pass
 * if a route forgot to mount the check, and "the map was right all along, the
 * route simply did not use it" is the bug that keeps happening.
 *
 * The table in docs/credentials-contract.md §3 is exhaustive, so this file is
 * two halves. What an expert may reach, which must keep working. And what they
 * may not, one case per row of the May-not column, because the value of that
 * column is entirely in it being tested — an SME who could open the candidate
 * list would look completely normal to everyone using the product.
 */

const app = createApp();

// Not a credential: bcrypt-hashed locally for fixture users that never sign in
// through the login route. Only `signToken` output authenticates them.
const FIXTURE_PASSPHRASE = 'not-a-real-passphrase-fixture';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let otherTenantId = '';
let roleId = '';
let scorecardId = '';
let assignedCandidateId = '';
let otherCandidateId = '';
let sessionId = '';
let otherSessionId = '';
let smeToken = '';
let otherSmeToken = '';
let otherSmeUserId = '';
let recruiterToken = '';
let adminToken = '';
let smeUserId = '';

async function makeUser(role: string, email: string, tenant = tenantId): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: { email, name: email, passwordHash: hashPassword(FIXTURE_PASSPHRASE), role, tenantId: tenant },
  });
  return { id: user.id, token: signToken({ userId: user.id, tenantId: tenant, role, email }) };
}

async function makeCandidate(name: string, email: string) {
  return prisma.candidate.create({
    data: { tenantId, roleId, fullName: name, email, emailNormalized: email },
  });
}

async function makeSession(candidateId: string) {
  return prisma.interviewSession.create({
    data: { tenantId, candidateId, roleId, scorecardId, state: 'COMPLETED', consentJson: '{}' },
  });
}

beforeAll(async () => {
  await wipe();

  const tenant = await prisma.tenant.create({ data: { name: 'Sme Org' } });
  tenantId = tenant.id;
  const other = await prisma.tenant.create({ data: { name: 'Someone Else Ltd' } });
  otherTenantId = other.id;

  const role = await prisma.role.create({ data: { tenantId, title: 'Staff Engineer', status: 'approved' } });
  roleId = role.id;
  const scorecard = await prisma.roleScorecardVersion.create({
    data: {
      roleId, version: 1, status: 'approved', approvedAt: new Date(),
      profileJson: JSON.stringify({
        roleContext: 'Builds the payments path.',
        outcomes: ['Ships the ledger rewrite'],
        competencies: [{ id: 'c1', name: 'Systems design', definition: 'Designs for failure', category: 'technical', classification: 'essential', weight: 1, requiredLevel: 'proficient', targetLevel: 'advanced', indicators: ['Names the failure mode first'], evidenceModes: ['technical_explanation'] }],
        // Present in the stored scorecard so the test can assert it is NOT served.
        scoringRules: { mustPassCompetencyIds: ['c1'], notEnoughEvidencePolicy: 'exclude', passThreshold: 72 },
      }),
    },
  });
  scorecardId = scorecard.id;

  const assigned = await makeCandidate('Priya Raman', 'priya@sme.test');
  assignedCandidateId = assigned.id;
  const unassigned = await makeCandidate('Someone Else', 'else@sme.test');
  otherCandidateId = unassigned.id;
  sessionId = (await makeSession(assignedCandidateId)).id;
  otherSessionId = (await makeSession(otherCandidateId)).id;

  const sme = await makeUser('sme', 'sme@sme.test');
  smeUserId = sme.id;
  smeToken = sme.token;
  const second = await makeUser('sme', 'sme2@sme.test');
  otherSmeUserId = second.id;
  otherSmeToken = second.token;
  recruiterToken = (await makeUser('recruiter', 'recruiter@sme.test')).token;
  adminToken = (await makeUser('admin', 'admin@sme.test')).token;

  // The recruiter owns the candidates, so the deny-tests below mean something:
  // an organisation where nobody owns anything denies everyone trivially.
  const recruiter = await prisma.user.findUniqueOrThrow({ where: { email: 'recruiter@sme.test' } });
  await prisma.candidateAssignment.createMany({
    data: [
      { candidateId: assignedCandidateId, userId: recruiter.id, relation: 'owner' },
      { candidateId: otherCandidateId, userId: recruiter.id, relation: 'owner' },
    ],
  });

  // The one grant this whole role rests on.
  await prisma.candidateAssignment.create({
    data: { candidateId: assignedCandidateId, userId: smeUserId, relation: 'sme' },
  });
  // The second expert is assigned the same candidate, so "may not read another
  // expert's review" is tested between two people who can both see the person.
  await prisma.candidateAssignment.create({
    data: { candidateId: assignedCandidateId, userId: otherSmeUserId, relation: 'sme' },
  });
});

describe('what a subject-matter expert may reach', () => {
  it('lists the candidates they were assigned, and nobody else', async () => {
    const res = await request(app).get('/api/sme/assignments').set(auth(smeToken));

    expect(res.status).toBe(200);
    expect(res.body.assignments.map((a: { candidateId: string }) => a.candidateId)).toEqual([assignedCandidateId]);
  });

  // The load-bearing half of the role, and the one that is easy to "fix" into a
  // blind view by someone applying least privilege without reading why this is
  // the exception (docs/credentials-contract.md §3).
  it('sees who the candidate is', async () => {
    const res = await request(app).get(`/api/sme/candidates/${assignedCandidateId}`).set(auth(smeToken));

    expect(res.body.candidate.name).toBe('Priya Raman');
  });

  it('sees the assigned candidate in the worklist by name too', async () => {
    const res = await request(app).get('/api/sme/assignments').set(auth(smeToken));

    expect(res.body.assignments[0].name).toBe('Priya Raman');
  });

  it('reads the approved scorecard', async () => {
    const res = await request(app).get(`/api/sme/candidates/${assignedCandidateId}`).set(auth(smeToken));

    expect(res.body.scorecard.competencies[0].name).toBe('Systems design');
  });

  // The threshold is how the machine turns evidence into a number. An expert
  // who has read it before writing is no longer an independent reading of the
  // same candidate, which is the only thing they were asked for.
  it('is not shown the scoring rules the AI grades against', async () => {
    const res = await request(app).get(`/api/sme/candidates/${assignedCandidateId}`).set(auth(smeToken));

    expect(res.body.scorecard.scoringRules).toBeUndefined();
  });

  it('reads the transcript of an interview with the candidate they were assigned', async () => {
    const res = await request(app)
      .get(`/api/sme/candidates/${assignedCandidateId}/interviews/${sessionId}/transcript`)
      .set(auth(smeToken));

    expect(res.status).toBe(200);
  });
});

describe('what a subject-matter expert may not reach', () => {
  it('refuses another candidate, as not found rather than forbidden', async () => {
    const res = await request(app).get(`/api/sme/candidates/${otherCandidateId}`).set(auth(smeToken));

    expect(res.status).toBe(404);
  });

  // The id in the path is a real candidate in the same organisation. Answering
  // 403 would confirm they exist, which is itself a disclosure about a person
  // this expert was never cleared to know about.
  it('answers the same for a candidate that is not theirs and one that does not exist', async () => {
    const theirs = await request(app).get(`/api/sme/candidates/${otherCandidateId}`).set(auth(smeToken));
    const nothing = await request(app).get('/api/sme/candidates/no-such-candidate').set(auth(smeToken));

    expect([theirs.status, theirs.body.error]).toEqual([nothing.status, nothing.body.error]);
  });

  // A session id from elsewhere in the same organisation would pass a tenant
  // check. The scope has to be the candidate, not the tenant.
  it('refuses a transcript belonging to a candidate they were not assigned', async () => {
    const res = await request(app)
      .get(`/api/sme/candidates/${assignedCandidateId}/interviews/${otherSessionId}/transcript`)
      .set(auth(smeToken));

    expect(res.status).toBe(404);
  });

  // An expert is asked to assess one person for one role, and is shown that
  // role's scorecard. A conversation held for a different job was judged
  // against a different standard, and the page never offers it — so reaching it
  // means typing the id.
  it('refuses a transcript recorded against a different role for the same candidate', async () => {
    const otherRole = await prisma.role.create({ data: { tenantId, title: 'Something Else', status: 'approved' } });
    const otherScorecard = await prisma.roleScorecardVersion.create({
      data: { roleId: otherRole.id, version: 1, status: 'approved', profileJson: '{}' },
    });
    const elsewhere = await prisma.interviewSession.create({
      data: { tenantId, candidateId: assignedCandidateId, roleId: otherRole.id, scorecardId: otherScorecard.id, state: 'COMPLETED', consentJson: '{}' },
    });

    const res = await request(app)
      .get(`/api/sme/candidates/${assignedCandidateId}/interviews/${elsewhere.id}/transcript`)
      .set(auth(smeToken));

    expect(res.status).toBe(404);
  });

  it('refuses the candidate list', async () => {
    expect((await request(app).get('/api/candidates').set(auth(smeToken))).status).toBe(403);
  });

  it('refuses a candidate through the hiring team\'s own route, even one they are assigned', async () => {
    expect((await request(app).get(`/api/candidates/${assignedCandidateId}`).set(auth(smeToken))).status).toBe(403);
  });

  it('refuses the roles list', async () => {
    expect((await request(app).get('/api/roles').set(auth(smeToken))).status).toBe(403);
  });

  it('refuses the pipeline', async () => {
    expect((await request(app).get(`/api/pipelines?candidateId=${assignedCandidateId}`).set(auth(smeToken))).status).toBe(403);
  });

  it('refuses the role\'s candidate comparison', async () => {
    expect((await request(app).get(`/api/roles/${roleId}/candidates`).set(auth(smeToken))).status).toBe(403);
  });

  it('refuses the interviews list', async () => {
    expect((await request(app).get('/api/interviews').set(auth(smeToken))).status).toBe(403);
  });

  it('refuses the audit log', async () => {
    expect((await request(app).get('/api/admin/audit').set(auth(smeToken))).status).toBe(403);
  });

  it('refuses the people in the organisation', async () => {
    expect((await request(app).get('/api/admin/users').set(auth(smeToken))).status).toBe(403);
  });

  it('refuses the tenant policy', async () => {
    expect((await request(app).get('/api/admin/policy').set(auth(smeToken))).status).toBe(403);
  });

  it('refuses the HR dashboard', async () => {
    expect((await request(app).get('/api/admin/hr-dashboard').set(auth(smeToken))).status).toBe(403);
  });

  it('rejects an unauthenticated caller before any scope lookup', async () => {
    expect((await request(app).get('/api/sme/assignments')).status).toBe(401);
  });
});

/**
 * The failure this describes has a delay fuse on it, which is why it is tested
 * rather than reasoned about: an expert's assignment is harmless while they are
 * an expert, and becomes a grant the moment somebody changes their role — an
 * act that looks nothing like granting access to anybody.
 */
describe('an expert assignment is not an ordinary claim on a candidate', () => {
  it('does not widen the candidate scope of an account that is later re-roled', async () => {
    const promoted = await makeUser('sme', 'promoted@sme.test');
    await prisma.candidateAssignment.create({
      data: { candidateId: assignedCandidateId, userId: promoted.id, relation: 'sme' },
    });

    // The same person, tomorrow, made a recruiter — with the assignment row
    // still standing because nothing in a role change removes one.
    await prisma.user.update({ where: { id: promoted.id }, data: { role: 'recruiter' } });
    const asRecruiter = signToken({ userId: promoted.id, tenantId, role: 'recruiter', email: 'promoted@sme.test' });

    const res = await request(app).get(`/api/candidates/${assignedCandidateId}`).set(auth(asRecruiter));

    expect(res.status).toBe(404);
  });

  it('still lets an ordinary assignment through, so the filter is not simply denying everything', async () => {
    const owner = await makeUser('recruiter', 'owner@sme.test');
    await prisma.candidateAssignment.create({
      data: { candidateId: assignedCandidateId, userId: owner.id, relation: 'owner' },
    });

    expect((await request(app).get(`/api/candidates/${assignedCandidateId}`).set(auth(owner.token))).status).toBe(200);
  });
});

describe('the expert surface is not a back door for anyone else', () => {
  // The whole point of /api/sme being separate is that it is narrower than the
  // roles around it. Admin is the one place in the capability map where admin
  // is not a superset, and this is why: a tenant-wide grant over a lane defined
  // by having been assigned a named person is a contradiction.
  it('refuses an admin the expert surface', async () => {
    expect((await request(app).get('/api/sme/assignments').set(auth(adminToken))).status).toBe(403);
  });

  it('refuses a recruiter the expert surface outright', async () => {
    expect((await request(app).get('/api/sme/assignments').set(auth(recruiterToken))).status).toBe(403);
  });

  // The delayed half of the failure the scope filter above closes.
  // CandidateAssignment rows outlive a role change, so an expert later made an
  // admin would otherwise go on writing recommendations through this lane —
  // attributed to an account that is nobody's subject-matter expert.
  it('stops a re-roled expert writing recommendations, with the assignment still standing', async () => {
    const promoted = await makeUser('sme', 'promoted-writer@sme.test');
    await prisma.candidateAssignment.create({
      data: { candidateId: assignedCandidateId, userId: promoted.id, relation: 'sme' },
    });
    await prisma.user.update({ where: { id: promoted.id }, data: { role: 'admin' } });
    const asAdmin = signToken({ userId: promoted.id, tenantId, role: 'admin', email: 'promoted-writer@sme.test' });

    const res = await request(app).put(`/api/sme/candidates/${assignedCandidateId}/review`)
      .set(auth(asAdmin))
      .send({ recommendation: 'proceed', feedback: 'Written after the role changed, which must not be possible.' });

    expect(res.status).toBe(403);
    expect(await prisma.smeReview.count({ where: { smeUserId: promoted.id } })).toBe(0);
  });

  /**
   * The same, through the session they still hold rather than a fresh one.
   *
   * Worth its own case because the obvious reading of the fix is that it works
   * only once the user signs in again — the token was minted while they were
   * an expert and still says so. It is not the token that decides: `authenticate`
   * re-reads the role from the database on every request precisely so that a
   * demotion takes effect on the next call rather than when the hour runs out.
   * A role change does not bump `sessionsEpoch`, so this token is still
   * perfectly valid; it simply no longer carries the authority it was minted
   * with.
   */
  it('stops them on the session they were already holding, without waiting for it to expire', async () => {
    const stillSignedIn = await makeUser('sme', 'still-signed-in@sme.test');
    await prisma.candidateAssignment.create({
      data: { candidateId: assignedCandidateId, userId: stillSignedIn.id, relation: 'sme' },
    });

    // Minted BEFORE the role change, and never refreshed.
    const oldToken = stillSignedIn.token;
    expect((await request(app).get('/api/sme/assignments').set(auth(oldToken))).status).toBe(200);

    await prisma.user.update({ where: { id: stillSignedIn.id }, data: { role: 'admin' } });

    expect((await request(app).get('/api/sme/assignments').set(auth(oldToken))).status).toBe(403);
    const write = await request(app).put(`/api/sme/candidates/${assignedCandidateId}/review`)
      .set(auth(oldToken))
      .send({ recommendation: 'proceed', feedback: 'Written on a token minted before the role changed.' });
    expect(write.status).toBe(403);
  });
});

describe('assigning an expert', () => {
  beforeEach(async () => {
    await prisma.candidateAssignment.deleteMany({ where: { candidateId: otherCandidateId, relation: 'sme' } });
  });

  it('lets a recruiter ask an expert to assess a candidate they own', async () => {
    const res = await request(app).post(`/api/candidates/${otherCandidateId}/sme`)
      .set(auth(recruiterToken)).send({ userId: smeUserId });

    expect(res.status).toBe(201);
    expect(res.body.assigned.map((a: { userId: string }) => a.userId)).toEqual([smeUserId]);
  });

  it('gives the expert access from that moment, and not before', async () => {
    const before = await request(app).get(`/api/sme/candidates/${otherCandidateId}`).set(auth(smeToken));
    await request(app).post(`/api/candidates/${otherCandidateId}/sme`).set(auth(recruiterToken)).send({ userId: smeUserId });
    const after = await request(app).get(`/api/sme/candidates/${otherCandidateId}`).set(auth(smeToken));

    expect([before.status, after.status]).toEqual([404, 200]);
  });

  // CandidateAssignment is also what services/access.ts reads for `candidateScope`,
  // so assigning an auditor here would hand candidate detail to the one role
  // defined by not having it. The role check is what stops this being a
  // general-purpose grant wearing an SME label.
  it('refuses to assign anyone who is not an expert', async () => {
    const auditor = await makeUser('auditor', 'auditor@sme.test');

    const res = await request(app).post(`/api/candidates/${otherCandidateId}/sme`)
      .set(auth(recruiterToken)).send({ userId: auditor.id });

    expect(res.status).toBe(400);
    expect(await prisma.candidateAssignment.count({ where: { userId: auditor.id } })).toBe(0);
  });

  it('refuses an expert from another organisation, as not found', async () => {
    const outsider = await makeUser('sme', 'outsider@sme.test', otherTenantId);

    const res = await request(app).post(`/api/candidates/${otherCandidateId}/sme`)
      .set(auth(recruiterToken)).send({ userId: outsider.id });

    expect(res.status).toBe(404);
  });

  it('refuses a second expert the ability to assign a third', async () => {
    const res = await request(app).post(`/api/candidates/${otherCandidateId}/sme`)
      .set(auth(smeToken)).send({ userId: otherSmeUserId });

    expect(res.status).toBe(403);
  });

  // A reviewer is deliberately the second opinion on the process rather than a
  // participant in it, so it does not choose who assesses whom.
  it('refuses a reviewer the ability to assign an expert', async () => {
    const reviewer = await makeUser('reviewer', 'reviewer@sme.test');

    const res = await request(app).post(`/api/candidates/${otherCandidateId}/sme`)
      .set(auth(reviewer.token)).send({ userId: smeUserId });

    expect(res.status).toBe(403);
  });

  it('takes the access away again when the expert is unassigned', async () => {
    await request(app).post(`/api/candidates/${otherCandidateId}/sme`).set(auth(recruiterToken)).send({ userId: smeUserId });
    await request(app).delete(`/api/candidates/${otherCandidateId}/sme/${smeUserId}`).set(auth(recruiterToken));

    expect((await request(app).get(`/api/sme/candidates/${otherCandidateId}`).set(auth(smeToken))).status).toBe(404);
  });

  // Unassigning an expert must not be a way to lock a colleague out of their
  // own candidate: the owner row and the sme row are both CandidateAssignment.
  it('leaves the owner\'s own assignment alone', async () => {
    const recruiter = await prisma.user.findUniqueOrThrow({ where: { email: 'recruiter@sme.test' } });

    await request(app).delete(`/api/candidates/${otherCandidateId}/sme/${recruiter.id}`).set(auth(recruiterToken));

    const still = await prisma.candidateAssignment.findFirst({ where: { candidateId: otherCandidateId, userId: recruiter.id } });
    expect(still?.relation).toBe('owner');
  });
});
