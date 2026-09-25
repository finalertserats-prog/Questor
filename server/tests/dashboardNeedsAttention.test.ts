import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { signToken } from '../src/services/auth.js';

// The dashboard's "needs a person" list: assessments waiting for review,
// interviews paused on an accommodation request, and candidates who asked to
// talk to someone. Scoped like every other dashboard figure.

const app = createApp();
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function setup() {
  const tenant = await prisma.tenant.create({ data: { name: 'Attention Org' } });
  const make = async (email: string) => {
    const user = await prisma.user.create({ data: { tenantId: tenant.id, email, name: email, passwordHash: 'x', role: 'recruiter' } });
    return { id: user.id, token: signToken({ userId: user.id, tenantId: tenant.id, role: 'recruiter', email }) };
  };
  const [me, other] = await Promise.all([make('me@attention.local'), make('other@attention.local')]);
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
  const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
  const candidateFor = async (fullName: string, ownerId: string) => {
    const candidate = await prisma.candidate.create({ data: { tenantId: tenant.id, roleId: role.id, fullName, email: `${fullName.replace(/\s+/g, '.').toLowerCase()}@m.local` } });
    await prisma.candidateAssignment.create({ data: { candidateId: candidate.id, userId: ownerId, relation: 'owner' } });
    return candidate;
  };
  const session = (candidateId: string, state: string, completedAt: Date | null = null) => prisma.interviewSession.create({
    data: { tenantId: tenant.id, candidateId, roleId: role.id, scorecardId: scorecard.id, state, completedAt },
  });
  return { tenant, me, other, role, scorecard, candidateFor, session };
}

async function humanRequest(o: { tenantId: string; candidateId: string; sessionId: string; requestedAt: Date }) {
  return prisma.candidateHumanRequest.create({
    data: {
      tenantId: o.tenantId, candidateId: o.candidateId, sessionId: o.sessionId, tokenHash: `hash-${o.sessionId}`,
      expiresAt: new Date(Date.now() + DAY), status: 'REQUESTED', requestedAt: o.requestedAt,
    },
  });
}

const metrics = (token: string) => request(app).get('/api/dashboard/metrics').set('Authorization', `Bearer ${token}`);

beforeEach(async () => { await wipe(); });

describe('dashboard needs attention', () => {
  it('lists reviews, accommodation requests and human requests for my candidates', async () => {
    const s = await setup();
    const ada = await s.candidateFor('Ada Review', s.me.id);
    const ben = await s.candidateFor('Ben Handoff', s.me.id);
    const cai = await s.candidateFor('Cai Talk', s.me.id);
    const review = await s.session(ada.id, 'REVIEW_READY', ago(1));
    await prisma.assessmentVersion.create({ data: { sessionId: review.id, scorecardId: s.scorecard.id, recommendation: 'CONSIDER', confidence: 0.7, evidenceCoverage: 0.6, resultJson: '{}' } });
    await s.session(ben.id, 'MANUAL_HANDOFF');
    const closed = await s.session(cai.id, 'CLOSED', ago(3));
    await humanRequest({ tenantId: s.tenant.id, candidateId: cai.id, sessionId: closed.id, requestedAt: ago(2) });

    const res = await metrics(s.me.token);

    expect(res.body.needsAttention.items.map((i: { kind: string; candidate: { name: string } }) => [i.kind, i.candidate.name]).sort()).toEqual([
      ['accommodation', 'Ben Handoff'], ['human_request', 'Cai Talk'], ['review', 'Ada Review'],
    ]);
  });

  it('points a review at its assessment', async () => {
    const s = await setup();
    const ada = await s.candidateFor('Ada Review', s.me.id);
    const review = await s.session(ada.id, 'REVIEW_READY', ago(1));
    const assessment = await prisma.assessmentVersion.create({ data: { sessionId: review.id, scorecardId: s.scorecard.id, recommendation: 'CONSIDER', confidence: 0.7, evidenceCoverage: 0.6, resultJson: '{}' } });

    const res = await metrics(s.me.token);

    expect(res.body.needsAttention.items[0].assessmentId).toBe(assessment.id);
  });

  it('dates an accommodation request by when it was made, not when the interview was set up', async () => {
    const s = await setup();
    const ada = await s.candidateFor('Ada Review', s.me.id);
    const ben = await s.candidateFor('Ben Handoff', s.me.id);
    const review = await s.session(ada.id, 'REVIEW_READY', ago(1));
    await prisma.assessmentVersion.create({ data: { sessionId: review.id, scorecardId: s.scorecard.id, recommendation: 'CONSIDER', confidence: 0.7, evidenceCoverage: 0.6, resultJson: '{}', createdAt: ago(1) } });
    const handoff = await s.session(ben.id, 'MANUAL_HANDOFF');
    const requestedAt = new Date().toISOString();
    await prisma.interviewSession.update({ where: { id: handoff.id }, data: { createdAt: ago(40), consentJson: JSON.stringify({ accommodationRequest: 'More time please.', accommodationRequestedAt: requestedAt }) } });

    const res = await metrics(s.me.token);

    expect([res.body.needsAttention.items[0].kind, res.body.needsAttention.items[0].at]).toEqual(['accommodation', requestedAt]);
  });

  it('counts each kind', async () => {
    const s = await setup();
    const ben = await s.candidateFor('Ben Handoff', s.me.id);
    await s.session(ben.id, 'MANUAL_HANDOFF');
    const res = await metrics(s.me.token);
    expect(res.body.needsAttention.counts).toEqual({ review: 0, accommodation: 1, human_request: 0, feedback_held: 0 });
  });

  it('leaves out candidates the caller cannot see', async () => {
    const s = await setup();
    const theirs = await s.candidateFor('Not Mine', s.other.id);
    await s.session(theirs.id, 'MANUAL_HANDOFF');
    const closed = await s.session(theirs.id, 'CLOSED', ago(3));
    await humanRequest({ tenantId: s.tenant.id, candidateId: theirs.id, sessionId: closed.id, requestedAt: ago(1) });

    const res = await metrics(s.me.token);

    expect(res.body.needsAttention.items).toEqual([]);
  });

  it('drops a human request once it is more than 30 days old', async () => {
    const s = await setup();
    const cai = await s.candidateFor('Cai Talk', s.me.id);
    const closed = await s.session(cai.id, 'CLOSED', ago(40));
    await humanRequest({ tenantId: s.tenant.id, candidateId: cai.id, sessionId: closed.id, requestedAt: ago(31) });

    const res = await metrics(s.me.token);

    expect(res.body.needsAttention.items).toEqual([]);
  });
});
