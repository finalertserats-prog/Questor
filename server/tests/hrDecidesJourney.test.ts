import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { finalizeInterview } from '../src/realtime/interviewEngine.js';
import { readTranscript } from './reviewGateHelpers.js';

/**
 * One candidate, all the way through, with nothing hand-built.
 *
 * This file exists because of a defect that survived a green suite for months:
 * awards_total was 0 in production while five candidates stood at Gold. Every
 * test that covered the award engine walked the pipeline with the Advance
 * button, and every test that covered the journey never looked at the awards —
 * so nothing anywhere asked the one question that mattered, which is whether a
 * candidate who goes through the product the way a real one does ends up
 * holding the credential the owner designed for them.
 *
 * So: onboarded through POST /api/candidates, CV read through
 * POST /api/candidates/:id/resume, interviewed through the portal, assessed by
 * finalizeInterview, reviewed through POST /api/assessments/:id/review, and
 * moved through POST /api/pipelines/:id/advance. No row is written by hand, no
 * stage is set directly. The two things being proved are that the assessment
 * moves nobody, and that the decision a person then makes mints the badge.
 */

const app = createApp();
const REASON = 'The evidence on the core competencies was clear and consistent.';

const RESUME = [
  'Pat Lee',
  'Senior Data Engineer',
  '',
  'Built Airflow and dbt pipelines on Snowflake; owned incident recovery and backfills.',
  '',
  'Skills: SQL, Python, Airflow, dbt, Snowflake',
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

function advance(ids: Seeded, journey: Journey, toStageKey: string) {
  return request(app).post(`/api/pipelines/${journey.pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey });
}

/**
 * An AI interview, conducted and scored.
 *
 * The invitation token is read from the response and used, and never printed:
 * a portal token is the candidate's way into their own interview, and a test
 * log is not a place to keep one.
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

async function review(ids: Seeded, assessmentId: string, verdict: string) {
  await readTranscript(app, assessmentId, ids.auth);
  return request(app).post(`/api/assessments/${assessmentId}/review`).set('Authorization', ids.auth)
    .send({ verdict, reason: REASON, overrides: [] });
}

const stageOf = (journey: Journey) =>
  prisma.candidatePipeline.findUniqueOrThrow({ where: { id: journey.pipelineId } }).then((p) => p.currentStageKey);

const tiersOf = (candidateId: string) =>
  prisma.candidateAward.findMany({ where: { candidateId }, orderBy: { awardedAt: 'asc' } });

async function queue(ids: Seeded) {
  const res = await request(app).get('/api/dashboard/needs-you').set('Authorization', ids.auth);
  return res.body.needsYou.items as {
    kind: string; candidate: { id: string; name: string } | null;
    facts: { stageLabel?: string; nextStageLabel?: string; readyBecause?: string };
    action: { label: string; to: string | null };
  }[];
}

const decisionsFor = (rows: Awaited<ReturnType<typeof queue>>, candidateId: string) =>
  rows.filter((r) => r.kind === 'stage_decision' && r.candidate?.id === candidateId);

describe('a candidate who goes the whole way through', () => {
  beforeEach(async () => { await wipe(); });

  it('holds Bronze and stands at Bronze once their CV has been read', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);

    expect([await stageOf(journey), (await tiersOf(journey.candidateId)).map((a) => a.tier)])
      .toEqual(['bronze', ['bronze']]);
  });

  it('is put in front of HR as a decision, because nothing will move them now', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);

    const [row] = decisionsFor(await queue(ids), journey.candidateId);

    expect({ name: row.candidate?.name, facts: row.facts, action: row.action }).toEqual({
      name: 'Pat Lee',
      facts: { stageLabel: 'Bronze', nextStageLabel: 'Silver', readyBecause: 'profile_read' },
      action: { label: 'Decide their next stage', to: `/candidates/${journey.candidateId}` },
    });
  });

  it('stays at Silver when their interview is assessed: the assessment moves nobody', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');

    await interviewed(ids, journey);

    // The Bronze move is still autonomous and still audited, so the question is
    // not whether anything moved them — it is whether an INTERVIEW event did.
    const autos = await prisma.auditEvent.findMany({ where: { action: 'pipeline.auto_advanced', entityId: journey.pipelineId } });
    const byInterview = autos.filter((a) => String(JSON.parse(a.afterJson).event).startsWith('interview.'));
    expect([await stageOf(journey), byInterview.length]).toEqual(['silver', 0]);
  });

  // The other half of the guarantee: while nobody has read the interview the
  // queue asks for the read, not for a promotion. Two rows for one person over
  // the same hours would be one candidate listed as two jobs.
  it('asks for the read first, and only asks for the move once a person has given it', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    const { assessmentId } = await interviewed(ids, journey);

    const beforeRead = await queue(ids);
    await review(ids, assessmentId, 'CONSIDER');
    const afterRead = await queue(ids);

    expect({
      before: { review: beforeRead.some((r) => r.kind === 'review'), decisions: decisionsFor(beforeRead, journey.candidateId).length },
      after: { review: afterRead.some((r) => r.kind === 'review'), facts: decisionsFor(afterRead, journey.candidateId)[0]?.facts },
    }).toEqual({
      before: { review: true, decisions: 0 },
      after: { review: false, facts: { stageLabel: 'Silver', nextStageLabel: 'Gold', readyBecause: 'interview_reviewed' } },
    });
  });

  it('is struck a Silver badge the moment HR moves them to Gold, and not before', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    const { assessmentId } = await interviewed(ids, journey);
    await review(ids, assessmentId, 'CONSIDER');
    const beforeDecision = (await tiersOf(journey.candidateId)).map((a) => a.tier);

    const moved = await advance(ids, journey, 'gold');

    expect({ before: beforeDecision, response: moved.body.awards, tiers: (await tiersOf(journey.candidateId)).map((a) => a.tier) })
      .toEqual({
        before: ['bronze'],
        response: [{ tier: 'silver', reference: expect.stringMatching(/^QS-SLV-[A-Z0-9]{4}-\d{4}$/) }],
        tiers: ['bronze', 'silver'],
      });
  });

  it('gives that badge its evidence, which is what the certificate is printed from', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    const { assessmentId } = await interviewed(ids, journey);
    await review(ids, assessmentId, 'CONSIDER');
    await advance(ids, journey, 'gold');

    const silver = (await tiersOf(journey.candidateId)).find((a) => a.tier === 'silver');
    const evidence = JSON.parse(silver?.evidenceJson ?? '{}') as { rows?: { what: string; when: string | null }[] };
    const rows = evidence.rows ?? [];

    expect({
      struckBy: silver?.awardedByUserId,
      verifiable: (silver?.verifyToken ?? '').length > 0,
      // Frozen at award time, so the certificate says what was true when it
      // was struck rather than what the database says years later. How many
      // rows and how they are worded belong to the certificate lane; what is
      // being proved here is that the badge arrived with its evidence at all.
      hasRows: rows.length > 0,
      everyRowSaysSomething: rows.every((row) => row.what.trim().length > 0),
      // The evidence a Silver certificate is about: the interview this
      // candidate actually sat, and the reading that got them to it.
      mentionsTheInterview: rows.some((row) => /interview/i.test(row.what)),
      mentionsTheScorecard: rows.some((row) => /scorecard/i.test(row.what)),
    }).toEqual({
      struckBy: ids.userId, verifiable: true, hasRows: true,
      everyRowSaysSomething: true, mentionsTheInterview: true, mentionsTheScorecard: true,
    });
  });

  it('leaves the decision row behind once it has been acted on', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);

    await advance(ids, journey, 'silver');

    expect(decisionsFor(await queue(ids), journey.candidateId)).toEqual([]);
  });
});

/**
 * The same journey where the reviewer says Proceed rather than Consider.
 *
 * Proceed IS the decision on the AI round, so it moves the candidate itself
 * and mints Silver on the way — which is precisely what the assessment's own
 * move used to steal by arriving first with nothing to give.
 */
describe('a reviewer who says Proceed', () => {
  beforeEach(async () => { await wipe(); });

  it('moves the candidate to Gold and strikes their Silver badge in the same act', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    const { assessmentId } = await interviewed(ids, journey);

    await review(ids, assessmentId, 'PROCEED');

    expect([await stageOf(journey), (await tiersOf(journey.candidateId)).map((a) => a.tier)])
      .toEqual(['gold', ['bronze', 'silver']]);
  });

  // The guard in resolveDecision, proved end to end: an interview conducted
  // while the pipeline still said Bronze used to let a Proceed carry the
  // candidate from Bronze to Gold, which skips Silver — and a tier nobody is
  // promoted out of is a tier nobody is ever struck.
  it('never vaults a candidate over Silver when nobody moved them there first', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    const { assessmentId } = await interviewed(ids, journey);

    await review(ids, assessmentId, 'PROCEED');

    expect([await stageOf(journey), (await tiersOf(journey.candidateId)).map((a) => a.tier)])
      .toEqual(['silver', ['bronze']]);
  });
});
