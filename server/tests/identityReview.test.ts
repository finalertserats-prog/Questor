import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { hashCode } from '../src/services/identityCode.js';

/**
 * What HR sees about identity on the review page, and the organisation's
 * assurance level in Settings. The panel reports; it never decides. There is
 * no reject action and nothing here changes the assessment or the pipeline.
 */

const app = createApp();

const Q1 = 'I\'d like to hear more about something on your CV. You wrote: "Led migration from Redshift to Snowflake, cutting warehouse cost by 35%." Can you walk me through it?';
const A1 = 'We ran both warehouses side by side for six weeks and cut over one domain at a time.';
const Q2 = 'One more from your CV: "Built streaming pipelines with Spark and Kafka for clickstream analytics." What problem did you run into along the way?';

type Ids = Awaited<ReturnType<typeof createDemoData>> & { assessmentId: string; auth: Record<string, string> };

async function reviewed(opts: { identityCheck?: Record<string, unknown> | null } = {}): Promise<Ids> {
  const ids = await createDemoData();
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId }, include: { plan: true } });
  const consent = JSON.parse(session.consentJson);
  if (opts.identityCheck !== null) consent.identityCheck = opts.identityCheck ?? { level: 'standard', method: 'email_code', channel: 'email' };
  const plan = JSON.parse(session.plan!.planJson);
  plan.blocks = plan.blocks.map((b: { competencyId: string }) => (b.competencyId === '__resume_validation__'
    ? { ...b, cvAnchors: [
      { source: 'employment', fact: 'Led migration from Redshift to Snowflake, cutting warehouse cost by 35%.', question: Q1 },
      { source: 'employment', fact: 'Built streaming pipelines with Spark and Kafka for clickstream analytics.', question: Q2 },
    ] }
    : b));
  await prisma.interviewPlanVersion.update({ where: { sessionId: ids.sessionId }, data: { planJson: JSON.stringify(plan) } });
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date(), consentJson: JSON.stringify(consent) } });
  await prisma.turn.createMany({
    data: [
      { sessionId: ids.sessionId, index: 0, speaker: 'agent', text: 'Welcome.', competencyId: '__process__' },
      { sessionId: ids.sessionId, index: 1, speaker: 'agent', text: `Thanks. ${Q1}`, competencyId: '__resume_validation__' },
      { sessionId: ids.sessionId, index: 2, speaker: 'candidate', text: A1, competencyId: '__resume_validation__' },
    ],
  });
  const created = await prisma.assessmentVersion.create({
    data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'PROCEED', confidence: 0.8, evidenceCoverage: 0.7, resultJson: '{}' },
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  return { ...ids, assessmentId: created.id, auth };
}

async function confirmCode(sessionId: string, attempts: number) {
  await prisma.identityCodeChallenge.create({
    data: { sessionId, codeHash: hashCode(sessionId, '123456'), expiresAt: new Date(Date.now() + 600_000), attempts, consumedAt: new Date() },
  });
}

const panel = (ids: Ids) => request(app).get(`/api/assessments/${ids.assessmentId}/identity`).set(ids.auth);

beforeEach(async () => { await wipe(); });

describe('the identity & integrity panel: the code', () => {
  it('shows the code as confirmed, with when and in how many entries', async () => {
    const ids = await reviewed();
    await confirmCode(ids.sessionId, 2);
    const res = await panel(ids);
    expect([res.status, res.body.code.state, typeof res.body.code.confirmedAt, res.body.code.attempts, res.body.code.wrongAttempts])
      .toEqual([200, 'confirmed', 'string', 2, 1]);
  });

  it('says plainly when the code was never entered', async () => {
    const ids = await reviewed();
    const res = await panel(ids);
    expect(res.body.code.state).toBe('not_confirmed');
  });

  it('says the check did not run when email could not be delivered', async () => {
    const ids = await reviewed({ identityCheck: { level: 'standard', method: 'none', reason: 'email_not_configured' } });
    expect((await panel(ids)).body.code.state).toBe('not_run');
  });

  it('says no code was asked for an interview agreed to before the check existed', async () => {
    const ids = await reviewed({ identityCheck: null });
    expect((await panel(ids)).body.code.state).toBe('not_recorded');
  });

  it('never carries the stored hash', async () => {
    const ids = await reviewed();
    await confirmCode(ids.sessionId, 1);
    const res = await panel(ids);
    expect(JSON.stringify(res.body).includes(hashCode(ids.sessionId, '123456'))).toBe(false);
  });
});

describe('the identity & integrity panel: CV follow-ups', () => {
  it('pairs each CV question asked with the answer given', async () => {
    const ids = await reviewed();
    const res = await panel(ids);
    expect(res.body.cvFollowUps.items[0]).toMatchObject({ question: Q1, answer: A1, asked: true });
  });

  it('lists a planned CV question the interview never reached as not asked', async () => {
    const ids = await reviewed();
    const res = await panel(ids);
    expect(res.body.cvFollowUps.items[1]).toMatchObject({ question: Q2, answer: null, asked: false });
  });

  it('shows which CV line each question came from', async () => {
    const ids = await reviewed();
    const res = await panel(ids);
    expect(res.body.cvFollowUps.items[0].cvDetail).toBe('Led migration from Redshift to Snowflake, cutting warehouse cost by 35%.');
  });
});

describe('the panel reports and never decides', () => {
  it('offers no actions at all', async () => {
    const ids = await reviewed();
    const res = await panel(ids);
    expect(res.body.actions).toBeUndefined();
  });

  it('leaves the assessment and the session untouched', async () => {
    const ids = await reviewed();
    await panel(ids);
    const [a, s] = await Promise.all([
      prisma.assessmentVersion.findUniqueOrThrow({ where: { id: ids.assessmentId } }),
      prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } }),
    ]);
    expect([a.recommendation, s.state]).toEqual(['PROCEED', 'REVIEW_READY']);
  });

  it('is not readable from another organisation', async () => {
    const ids = await reviewed();
    const other = await prisma.tenant.create({ data: { name: 'Other' } });
    const user = await prisma.user.create({ data: { tenantId: other.id, email: 'x@other.test', name: 'X', passwordHash: 'x', role: 'admin' } });
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/identity`)
      .set({ Authorization: `Bearer ${signToken({ userId: user.id, tenantId: other.id, role: 'admin', email: user.email })}` });
    expect(res.status).toBe(404);
  });
});

describe('the organisation assurance level', () => {
  it('is Standard for an organisation that never chose', async () => {
    const ids = await reviewed();
    const res = await request(app).get('/api/admin/identity-assurance').set(ids.auth);
    expect(res.body.level).toBe('standard');
  });

  it('lists Enhanced and Verified as not available yet', async () => {
    const ids = await reviewed();
    const res = await request(app).get('/api/admin/identity-assurance').set(ids.auth);
    expect(res.body.levels.map((l: { id: string; available: boolean }) => [l.id, l.available]))
      .toEqual([['standard', true], ['enhanced', false], ['verified', false]]);
  });

  it('saves Standard', async () => {
    const ids = await reviewed();
    const res = await request(app).put('/api/admin/policy').set(ids.auth).send({ policy: { identityAssuranceLevel: 'standard' } });
    expect(res.status).toBe(200);
  });

  it('refuses a level that is not available yet', async () => {
    const ids = await reviewed();
    const res = await request(app).put('/api/admin/policy').set(ids.auth).send({ policy: { identityAssuranceLevel: 'verified' } });
    expect(res.status).toBe(400);
  });

  it('refuses to switch identity checks off', async () => {
    const ids = await reviewed();
    const res = await request(app).put('/api/admin/policy').set(ids.auth).send({ policy: { identityAssuranceLevel: 'off' } });
    expect(res.status).toBe(400);
  });
});
