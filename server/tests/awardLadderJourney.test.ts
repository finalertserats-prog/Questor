import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { finalizeInterview } from '../src/realtime/interviewEngine.js';
import { readTranscript } from './reviewGateHelpers.js';
import { parseStoredEvidence } from '../src/services/awardEvidence.js';

/**
 * The observed defect, walked through the real endpoints.
 *
 * A reviewer recorded PROCEED on an assessed, human-reviewed AI interview. The
 * pipeline stood at Gold afterwards and the database held exactly one award,
 * Bronze. No Silver row at all — for a candidate who had demonstrably been
 * carried OUT of Silver, which is the single act that earns it.
 *
 * Two independent holes produced that, and either alone reproduces it:
 *
 *   - `interview.assessed` moved the candidate Silver → Gold through
 *     `applyPipelineEvent`, which writes a stage and never calls the award
 *     engine. The tier was left behind by a move nobody was credited with.
 *   - The verdict's own decision then resolved to nothing, because the
 *     candidate was already past the round it was about. When it DID resolve
 *     it vaulted Bronze → Gold in one move, and `awardsForPromotion` earns
 *     Silver only on a move whose `from` is Silver.
 *
 * So the assertions below are about the journey a real person takes, never
 * about a stage set by hand: every row here is written by an endpoint.
 *
 * Each test states first that the fixture actually got somewhere. An awards
 * assertion passes vacuously against a candidate who has no pipeline, and a
 * `.not.toContain` passes against an empty list, so the standing is asserted
 * in the same expectation as the tiers rather than trusted.
 */

const app = createApp();
const REASON = 'The evidence on the core competencies was clear and consistent.';

/**
 * A CV long enough to be readable against the demo role's scorecard.
 *
 * Bronze is struck only from a fit the product is willing to compare on, and a
 * six-line CV bands as `not_enough_evidence` — correctly. A short fixture would
 * have left this whole file asserting the ladder for a candidate who never got
 * onto the bottom rung, which is the vacuous-pass trap in its purest form.
 */
const RESUME = [
  'Pat Lee',
  'Senior Data Engineer | Bengaluru',
  'pat.lee@example.test',
  '',
  'Experience:',
  'Senior Data Engineer, Northwind Data (2021 - Present)',
  '- Owned the analytical data platform on Snowflake serving 200+ internal analysts.',
  '- Designed dimensional data models and slowly changing dimensions for finance reporting.',
  '- Built and operated Airflow + dbt pipelines processing 4TB/day; cut pipeline failures by 60% with idempotent recovery and better detection.',
  '- Led the migration from Redshift to Snowflake, cutting warehouse cost by 35%.',
  '- Optimized critical SQL, improving key report latency from 90s to under 8s using partitioning and clustering.',
  '',
  'Data Engineer, ShopStack (2018 - 2021)',
  '- Built streaming pipelines with Spark and Kafka for clickstream analytics.',
  '- Implemented observability and alerting; established on-call runbooks and SLAs.',
  '- Architected the AWS data platform for changing volume, cost and SLA.',
  '- Partnered with analysts and product on data governance, security and compliance reviews.',
  '',
  'Skills: SQL, Python, Airflow, dbt, Spark, Kafka, Snowflake, Redshift, BigQuery, AWS, data modelling, data governance',
  '',
  'Education: B.E. Computer Science, 2018.',
].join('\n');

const ANSWERS = [
  'I owned the ledger pipeline end to end and made recovery idempotent after a reconciliation incident.',
  'Unmatched rows fell from two thousand a day to under thirty over the quarter.',
];

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;

interface Journey {
  readonly candidateId: string;
  readonly pipelineId: string;
}

/** Onboarded and CV read, both through the endpoints a recruiter actually uses. */
async function onboarded(ids: Seeded): Promise<Journey> {
  const created = await request(app).post('/api/candidates').set('Authorization', ids.auth)
    .send({ fullName: 'Pat Lee', email: 'pat.lee@example.test', roleId: ids.roleId });
  const candidateId = created.body.candidate.id as string;
  await request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', ids.auth).send({ text: RESUME });
  const pipeline = await prisma.candidatePipeline.findFirstOrThrow({ where: { candidateId } });
  return { candidateId, pipelineId: pipeline.id };
}

/**
 * An AI interview, conducted and scored.
 *
 * The invitation token is read from the response and never printed: it is the
 * candidate's way into their own interview, and a test log is not a place to
 * keep one.
 */
async function interviewed(ids: Seeded, journey: Journey): Promise<{ sessionId: string; assessmentId: string }> {
  const created = await request(app).post('/api/interviews').set('Authorization', ids.auth)
    .send({ candidateId: journey.candidateId, durationMinutes: 30, language: 'en', modules: [], approve: true });
  const sessionId = created.body.session.id as string;
  const invited = await request(app).post(`/api/interviews/${sessionId}/invite`).set('Authorization', ids.auth).send({});
  const token = invited.body.invitation.token as string;

  await request(app).post(`/api/portal/${token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${token}/start`).send({});
  for (const text of ANSWERS) await request(app).post(`/api/portal/${token}/turn`).send({ text });
  await finalizeInterview(sessionId);

  const assessment = await prisma.assessmentVersion.findFirstOrThrow({ where: { sessionId }, orderBy: { version: 'desc' } });
  return { sessionId, assessmentId: assessment.id };
}

async function review(ids: Seeded, assessmentId: string, verdict = 'PROCEED') {
  await readTranscript(app, assessmentId, ids.auth);
  return request(app).post(`/api/assessments/${assessmentId}/review`).set('Authorization', ids.auth)
    .send({ verdict, reason: REASON, overrides: [] });
}

function advance(ids: Seeded, journey: Journey, toStageKey: string) {
  return request(app).post(`/api/pipelines/${journey.pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey });
}

const stageOf = (journey: Journey) =>
  prisma.candidatePipeline.findUniqueOrThrow({ where: { id: journey.pipelineId } }).then((p) => p.currentStageKey);

const awardsOf = (candidateId: string) =>
  prisma.candidateAward.findMany({ where: { candidateId }, orderBy: { awardedAt: 'asc' } });

/**
 * The whole journey up to the point a person has read the interview and said
 * Proceed. Shared because every assertion below is about the state it leaves.
 */
async function reviewedAndProceeded(ids: Seeded) {
  const journey = await onboarded(ids);
  const { assessmentId } = await interviewed(ids, journey);
  const stageBefore = await stageOf(journey);
  const res = await review(ids, assessmentId);
  return { journey, assessmentId, stageBefore, reviewStatus: res.status };
}

describe('the Silver a reviewer’s Proceed is supposed to earn', () => {
  beforeEach(async () => { await wipe(); });

  // The premise of every test below, asserted rather than assumed. Bronze is
  // struck only from a fit the product will compare on, so a fixture whose CV
  // banded as unreadable would make the Silver assertions arguments about a
  // candidate who never earned anything.
  it('holds Bronze from the CV reading alone, before anyone has decided anything', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);

    expect((await awardsOf(journey.candidateId)).map((a) => a.tier)).toEqual(['bronze']);
  });

  it('strikes Silver for a candidate carried out of Silver by a recorded verdict', async () => {
    const ids = await seeded();
    const { journey, stageBefore, reviewStatus } = await reviewedAndProceeded(ids);

    const tiers = (await awardsOf(journey.candidateId)).map((a) => a.tier);

    // The standing rides in the same expectation as the tiers on purpose: a
    // tiers assertion alone is green for a candidate the fixture never moved.
    expect({ reviewStatus, stageBefore, reached: await stageOf(journey), tiers }).toEqual({
      reviewStatus: 201,
      stageBefore: 'silver',
      reached: 'gold',
      tiers: ['bronze', 'silver'],
    });
  });

  it('gives that Silver the frozen evidence and the verification token a certificate is printed from', async () => {
    const ids = await seeded();
    const { journey } = await reviewedAndProceeded(ids);

    const silver = (await awardsOf(journey.candidateId)).find((a) => a.tier === 'silver');
    const evidence = silver ? parseStoredEvidence(silver.tier, silver.evidenceJson) : null;

    expect({
      reference: silver?.reference.startsWith('QS-SLV-') ?? false,
      verifyToken: (silver?.verifyToken.length ?? 0) >= 16,
      awardedBy: silver?.awardedByUserId === ids.userId,
      rows: evidence?.rows.length ?? 0,
      candidateName: evidence && 'candidateName' in evidence ? evidence.candidateName : null,
    }).toEqual({ reference: true, verifyToken: true, awardedBy: true, rows: 5, candidateName: 'Pat Lee' });
  });

  it('names the reviewer who assessed the interview on the Silver it earned', async () => {
    const ids = await seeded();
    const { journey } = await reviewedAndProceeded(ids);

    const silver = (await awardsOf(journey.candidateId)).find((a) => a.tier === 'silver');
    const evidence = silver ? parseStoredEvidence(silver.tier, silver.evidenceJson) : null;
    const assessedBy = evidence && 'signatures' in evidence ? evidence.signatures.left : null;

    // Not "Questor". A Silver struck by a move that happened after a person
    // read the transcript must carry that person, or the certificate claims an
    // unassessed interview for an interview somebody assessed.
    expect(assessedBy?.role).toBe('Assessed by · subject-matter expert');
  });

  it('never mints Bronze twice and never mints a Diamond on the way to Gold', async () => {
    const ids = await seeded();
    const { journey } = await reviewedAndProceeded(ids);

    const tiers = (await awardsOf(journey.candidateId)).map((a) => a.tier);

    expect({ bronze: tiers.filter((t) => t === 'bronze').length, diamond: tiers.includes('diamond'), total: tiers.length })
      .toEqual({ bronze: 1, diamond: false, total: 2 });
  });
});

describe('what the candidate’s page says about the round that was assessed', () => {
  beforeEach(async () => { await wipe(); });

  it('stops saying no assessed AI interview about the interview it has just assessed', async () => {
    const ids = await seeded();
    const { journey } = await reviewedAndProceeded(ids);

    const res = await request(app).get(`/api/pipelines/${journey.pipelineId}/summary`).set('Authorization', ids.auth);
    const silver = (res.body.summary.stages as { key: string; hasEvidence: boolean; detail: string }[])
      .find((s) => s.key === 'silver');

    expect({ status: res.status, hasEvidence: silver?.hasEvidence, saysNone: silver?.detail.includes('No assessed AI interview yet') })
      .toEqual({ status: 200, hasEvidence: true, saysNone: false });
  });

  it('still says so for a candidate whose AI interview has not been assessed', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);

    const res = await request(app).get(`/api/pipelines/${journey.pipelineId}/summary`).set('Authorization', ids.auth);
    const silver = (res.body.summary.stages as { key: string; hasEvidence: boolean; detail: string }[])
      .find((s) => s.key === 'silver');

    // The other half of the pair. Without it, a fix that hard-coded evidence
    // on every Silver would pass the test above.
    expect({ hasEvidence: silver?.hasEvidence, detail: silver?.detail })
      .toEqual({ hasEvidence: false, detail: 'No assessed AI interview yet.' });
  });
});

describe('the tiers a Gold candidate goes on to earn', () => {
  beforeEach(async () => { await wipe(); });

  it('strikes Gold and Diamond together on the single move out of Gold', async () => {
    const ids = await seeded();
    const { journey } = await reviewedAndProceeded(ids);

    const moved = await advance(ids, journey, 'diamond');
    const tiers = (await awardsOf(journey.candidateId)).map((a) => a.tier);

    expect({ status: moved.status, reached: await stageOf(journey), tiers })
      .toEqual({ status: 200, reached: 'diamond', tiers: ['bronze', 'silver', 'gold', 'diamond'] });
  });
});
