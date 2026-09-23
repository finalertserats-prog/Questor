import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { eraseCandidate } from '../src/services/dataRights.js';
import { invitationSecretColumns, mintInvitationToken } from '../src/services/invitations.js';
import { getOutcomeReport } from '../src/services/outcomeStats.js';
import { buildSnapshot, runOutcomeSnapshots, snapshotMonth } from '../src/services/outcomeSnapshot.js';

/**
 * GET /api/reports/outcomes, end to end: who may read it, what it counts, what
 * the CSV is safe to open, and that keeping monthly aggregates never stands
 * between a candidate and their erasure.
 */

const app = createApp();
const now = new Date('2026-09-20T12:00:00.000Z');
const MONTH = snapshotMonth(now);

async function makeUser(tenantId: string, email: string, role: string) {
  const user = await prisma.user.create({ data: { tenantId, email, name: email, passwordHash: 'x', role } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

async function makeRole(tenantId: string, title: string, over: { experienceBand?: string; regionCode?: string } = {}) {
  const role = await prisma.role.create({ data: { tenantId, title, status: 'approved', ...over } });
  const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
  return { role, scorecard };
}

interface InterviewOptions {
  readonly tenantId: string;
  readonly roleId: string;
  readonly scorecardId: string;
  readonly name: string;
  readonly interviewerId?: string;
  readonly state?: string;
  readonly invited?: boolean;
  readonly assessed?: boolean;
  readonly overallScore?: number;
  readonly humanVerdict?: string;
  readonly createdAt?: Date;
}

async function makeInterview(o: InterviewOptions) {
  const candidate = await prisma.candidate.create({
    data: { tenantId: o.tenantId, roleId: o.roleId, fullName: o.name, email: `${o.name}@m.local`, emailNormalized: `${o.name}@m.local` },
  });
  const session = await prisma.interviewSession.create({
    data: {
      tenantId: o.tenantId, roleId: o.roleId, scorecardId: o.scorecardId, candidateId: candidate.id,
      state: o.state ?? 'REVIEW_READY',
      personaJson: JSON.stringify({ interviewerId: o.interviewerId ?? 'maya' }),
      startedAt: now, completedAt: new Date(now.getTime() + 30 * 60_000),
      createdAt: o.createdAt ?? now,
    },
  });
  if (o.invited !== false) {
    await prisma.invitation.create({ data: { sessionId: session.id, ...invitationSecretColumns(mintInvitationToken()), sentAt: now } });
  }
  let assessment = null;
  if (o.assessed !== false) {
    assessment = await prisma.assessmentVersion.create({
      data: {
        sessionId: session.id, scorecardId: o.scorecardId, recommendation: 'PROCEED', evidenceCoverage: 0.8,
        resultJson: JSON.stringify({
          overallScore: o.overallScore ?? 70,
          competencies: [{ id: 'sql', name: 'SQL', level: 4, notEnoughEvidence: false }],
        }),
      },
    });
  }
  if (assessment && o.humanVerdict) {
    const reviewer = await prisma.user.findFirst({ where: { tenantId: o.tenantId }, select: { id: true } });
    await prisma.humanReview.create({
      data: {
        assessmentId: assessment.id, reviewerId: reviewer!.id, status: 'COMPLETED',
        disposition: o.humanVerdict, activeForAssessmentId: assessment.id, completedAt: now,
      },
    });
  }
  return { candidate, session, assessment };
}

let tenantId = '';
let admin: { id: string; token: string };
let roleId = '';
let scorecardId = '';

beforeEach(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme' } });
  tenantId = tenant.id;
  admin = await makeUser(tenantId, 'admin@acme.test', 'admin');
  const made = await makeRole(tenantId, 'Backend Engineer', { experienceBand: 'established', regionCode: 'in' });
  roleId = made.role.id;
  scorecardId = made.scorecard.id;
});

describe('GET /api/reports/outcomes', () => {
  it('lets a manager read the organisation’s outcomes', async () => {
    const manager = await makeUser(tenantId, 'manager@acme.test', 'manager');
    const res = await request(app).get('/api/reports/outcomes').set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
  });

  it('keeps a recruiter out of the whole organisation’s outcome rates', async () => {
    const recruiter = await makeUser(tenantId, 'recruiter@acme.test', 'recruiter');
    const res = await request(app).get('/api/reports/outcomes').set('Authorization', `Bearer ${recruiter.token}`);
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await request(app).get('/api/reports/outcomes')).status).toBe(401);
  });

  it('rejects an unexpected query key rather than ignoring it', async () => {
    const res = await request(app).get(`/api/reports/outcomes?tenantId=${tenantId}`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(400);
  });

  it('rejects a period that ends before it starts', async () => {
    const res = await request(app)
      .get('/api/reports/outcomes?from=2026-09-01&to=2026-08-01')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(400);
  });

  it('counts an interview at every step it reached', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', humanVerdict: 'PROCEED' });
    const res = await request(app).get('/api/reports/outcomes').set('Authorization', `Bearer ${admin.token}`);
    const counts = Object.fromEntries((res.body.funnel as Array<{ key: string; count: number }>).map((s) => [s.key, s.count]));
    expect(counts).toMatchObject({ invited: 1, started: 1, completed: 1, assessed: 1, humanReviewed: 1, proceed: 1 });
  });

  it('states the minimum sample it holds every rate to', async () => {
    const res = await request(app).get('/api/reports/outcomes').set('Authorization', `Bearer ${admin.token}`);
    expect(res.body.minSample).toBe(20);
  });

  it('marks the rates of a one-interview organisation unreadable', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', humanVerdict: 'PROCEED' });
    const res = await request(app).get('/api/reports/outcomes').set('Authorization', `Bearer ${admin.token}`);
    const started = (res.body.funnel as Array<{ key: string; ofBasis: { readable: boolean } | null }>).find((s) => s.key === 'started');
    expect(started?.ofBasis?.readable).toBe(false);
  });

  it('keeps another organisation’s interviews out of the numbers', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other' } });
    await makeUser(other.id, 'other@other.test', 'admin');
    const otherRole = await makeRole(other.id, 'Other role');
    await makeInterview({ tenantId: other.id, roleId: otherRole.role.id, scorecardId: otherRole.scorecard.id, name: 'zoe', humanVerdict: 'PROCEED' });
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann' });

    const res = await request(app).get('/api/reports/outcomes').set('Authorization', `Bearer ${admin.token}`);
    expect(res.body.interviews).toBe(1);
  });

  it('leaves out an interview created outside the period', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'old', createdAt: new Date('2025-01-01T00:00:00.000Z') });
    const res = await request(app)
      .get('/api/reports/outcomes?from=2026-09-01&to=2026-10-01')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.body.interviews).toBe(0);
  });

  it('cuts by AI interviewer, carrying each one’s sample size', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', interviewerId: 'maya' });
    await makeInterview({ tenantId, roleId, scorecardId, name: 'bea', interviewerId: 'theo' });
    const res = await request(app).get('/api/reports/outcomes').set('Authorization', `Bearer ${admin.token}`);
    expect((res.body.cuts.interviewer as Array<{ key: string; n: number }>).map((g) => g.key).sort()).toEqual(['maya', 'theo']);
  });

  it('carries the blind-verdict agreement harness verbatim rather than a second statistic', async () => {
    const res = await request(app).get('/api/reports/outcomes').set('Authorization', `Bearer ${admin.token}`);
    expect(res.body.agreement.gate.threshold).toBe(0.75);
    expect(res.body.agreement.sufficiency.statement).toContain('No blind human verdicts');
  });

  it('says out loud that the agreement figures do not follow the page’s own filters', async () => {
    const res = await request(app).get('/api/reports/outcomes?roleId=nope').set('Authorization', `Bearer ${admin.token}`);
    expect(res.body.agreementScopeNote).toContain('whole organisation');
  });

  it('counts a hire decided after the period ended, off an interview inside it', async () => {
    const made = await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', humanVerdict: 'PROCEED' });
    await prisma.candidatePipeline.create({
      data: {
        tenantId, roleId, candidateId: made.candidate.id, stagesJson: '', currentStageKey: 'diamond',
        status: 'DECIDED', decision: 'APPROVED', decidedAt: new Date('2026-10-15T00:00:00.000Z'),
      },
    });
    const res = await request(app)
      .get('/api/reports/outcomes?from=2026-09-01&to=2026-10-01')
      .set('Authorization', `Bearer ${admin.token}`);
    expect((res.body.funnel as Array<{ key: string; count: number }>).find((s) => s.key === 'hired')?.count).toBe(1);
  });

  it('scopes a manager with role assignments to the roles they hold', async () => {
    const manager = await makeUser(tenantId, 'limited@acme.test', 'manager');
    const mine = await makeRole(tenantId, 'Mine');
    await prisma.roleAssignment.create({ data: { roleId: mine.role.id, userId: manager.id } });
    await makeInterview({ tenantId, roleId: mine.role.id, scorecardId: mine.scorecard.id, name: 'ann' });
    await makeInterview({ tenantId, roleId, scorecardId, name: 'bea' });

    const res = await request(app).get('/api/reports/outcomes').set('Authorization', `Bearer ${manager.token}`);
    expect(res.body.interviews).toBe(1);
  });
});

describe('the CSV export', () => {
  it('sends a spreadsheet, named for its period', async () => {
    const res = await request(app).get('/api/reports/outcomes?format=csv').set('Authorization', `Bearer ${admin.token}`);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('questor-outcomes-');
  });

  it('gives every rate its denominator in the file itself', async () => {
    const res = await request(app).get('/api/reports/outcomes?format=csv').set('Authorization', `Bearer ${admin.token}`);
    expect(res.text.split('\n')[0]).toBe('section,dimension,group,measure,numerator,denominator,rate,readable,note');
  });

  it('says, in the file, that a small sample must not be read', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', humanVerdict: 'PROCEED' });
    const res = await request(app).get('/api/reports/outcomes?format=csv').set('Authorization', `Bearer ${admin.token}`);
    expect(res.text).toContain('Sample below the minimum; this rate must not be read.');
  });

  it('defuses a role title whose leading whitespace hides a formula', async () => {
    const evil = await makeRole(tenantId, '\n=cmd|/c calc');
    await makeInterview({ tenantId, roleId: evil.role.id, scorecardId: evil.scorecard.id, name: 'ann' });
    const res = await request(app).get('/api/reports/outcomes?format=csv').set('Authorization', `Bearer ${admin.token}`);
    // A cut's label is trimmed before it reaches the cell, so the newline is
    // gone by then; what must survive is that the cell still cannot begin with
    // a formula. csvCell's own LF rule is tested directly in csv.test.ts.
    expect(res.text).toContain("'=cmd|/c calc v1");
    expect(res.text).not.toMatch(/(^|,)=cmd/m);
  });

  it('defuses a role title a spreadsheet would otherwise run as a formula', async () => {
    const evil = await makeRole(tenantId, '=cmd|/c calc');
    await makeInterview({ tenantId, roleId: evil.role.id, scorecardId: evil.scorecard.id, name: 'ann' });
    const res = await request(app).get('/api/reports/outcomes?format=csv').set('Authorization', `Bearer ${admin.token}`);
    // Apostrophe-prefixed, so the cell opens as text; never at the start of a cell as a live formula.
    expect(res.text).toContain("'=cmd|/c calc v1");
    expect(res.text).not.toMatch(/(^|,)=cmd/m);
  });

  it('never prints a verdict in the storage vocabulary', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', humanVerdict: 'PROCEED' });
    const res = await request(app).get('/api/reports/outcomes?format=csv').set('Authorization', `Bearer ${admin.token}`);
    expect(res.text).not.toMatch(/\bAPPROVED\b|\bREJECTED\b/);
    expect(res.text).toContain('Do not progress');
  });
});

describe('monthly snapshots', () => {
  it('keeps counts for the month and nothing about a person', async () => {
    const made = await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', humanVerdict: 'PROCEED' });
    const snapshot = await buildSnapshot({ userId: '', tenantId, role: 'admin', email: '' }, MONTH);

    expect(snapshot.interviews).toBe(1);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain(made.candidate.id);
    expect(json).not.toContain(made.session.id);
    expect(json).not.toContain('ann');
  });

  it('folds a group too small to keep separately into one "other" row', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', interviewerId: 'maya' });
    const snapshot = await buildSnapshot({ userId: '', tenantId, role: 'admin', email: '' }, MONTH);
    expect(snapshot.cuts.interviewer.map((c) => c.label)).toEqual(['Other (groups too small to keep separately)']);
  });

  it('keeps no outcome rate even on the folded row when the fold is itself a handful of people', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', interviewerId: 'maya', humanVerdict: 'PROCEED' });
    const snapshot = await buildSnapshot({ userId: '', tenantId, role: 'admin', email: '' }, MONTH);
    expect(snapshot.cuts.interviewer[0]).toMatchObject({ n: 1, proceed: null });
  });

  it('keeps no median or health figure for a month that is one person’s interview', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', overallScore: 71, humanVerdict: 'PROCEED' });
    const snapshot = await buildSnapshot({ userId: '', tenantId, role: 'admin', email: '' }, MONTH);

    expect(snapshot).toMatchObject({ interviews: 1, scoreMedian: null, scoreBuckets: null, health: null });
    // The count of interviews is still kept: it identifies nobody, and losing
    // it would leave a hole in the trend that reads as "nothing happened".
    expect(snapshot.funnel.find((f) => f.key === 'invited')?.count).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('71');
  });

  it('keeps the medians once the month is big enough for them to be about nobody in particular', async () => {
    for (let i = 0; i < 5; i += 1) {
      await makeInterview({ tenantId, roleId, scorecardId, name: `p${i}`, overallScore: 60 + i, humanVerdict: 'PROCEED' });
    }
    const snapshot = await buildSnapshot({ userId: '', tenantId, role: 'admin', email: '' }, MONTH);
    expect(snapshot.scoreMedian).toBe(62);
    expect(snapshot.health).not.toBeNull();
  });

  it('snapshots every organisation, not just the first page of them', async () => {
    const extra = await prisma.tenant.create({ data: { name: 'Zed' } });
    await runOutcomeSnapshots(now);
    expect(await prisma.outcomeSnapshot.findFirst({ where: { tenantId: extra.id, month: MONTH } })).not.toBeNull();
  });

  it('keeps a manager out of the stored whole-organisation history', async () => {
    const manager = await makeUser(tenantId, 'manager2@acme.test', 'manager');
    const res = await request(app).get('/api/reports/outcomes/snapshots').set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(403);
  });

  it('writes one row per organisation-month and rewrites it on the next run', async () => {
    await makeInterview({ tenantId, roleId, scorecardId, name: 'ann' });
    await runOutcomeSnapshots(now);
    await makeInterview({ tenantId, roleId, scorecardId, name: 'bea' });
    await runOutcomeSnapshots(now);

    const rows = await prisma.outcomeSnapshot.findMany({ where: { tenantId, month: MONTH } });
    expect(rows).toHaveLength(1);
    expect(rows[0].interviews).toBe(2);
  });

  it('serves the stored months to a manager', async () => {
    await runOutcomeSnapshots(now);
    const res = await request(app).get('/api/reports/outcomes/snapshots').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect((res.body.months as Array<{ month: string }>).map((m) => m.month)).toContain(MONTH);
  });

  it('does not stand between a candidate and their erasure', async () => {
    const made = await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', humanVerdict: 'PROCEED' });
    await runOutcomeSnapshots(now);

    await expect(eraseCandidate({ tenantId, candidateId: made.candidate.id, actorId: admin.id, reason: 'request' })).resolves.toBeTruthy();
    expect(await prisma.candidate.findUnique({ where: { id: made.candidate.id } })).toBeNull();
  });

  it('keeps the month’s numbers after the people in it are erased', async () => {
    const made = await makeInterview({ tenantId, roleId, scorecardId, name: 'ann', humanVerdict: 'PROCEED' });
    await runOutcomeSnapshots(now);
    await eraseCandidate({ tenantId, candidateId: made.candidate.id, actorId: admin.id, reason: 'request' });

    const stored = await prisma.outcomeSnapshot.findFirst({ where: { tenantId, month: MONTH } });
    expect(stored?.interviews).toBe(1);
    // And the live report, which reads the data that is left, now says zero —
    // which is exactly why the snapshot exists.
    const live = await getOutcomeReport({ userId: admin.id, tenantId, role: 'admin', email: 'admin@acme.test' });
    expect(live.interviews).toBe(0);
  });
});
