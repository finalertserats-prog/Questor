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
    // Both halves asserted: an empty list on its own would still pass if the
    // kind had been deleted from the queue altogether.
    const before = decisionsFor(await queue(ids), journey.candidateId).length;

    await advance(ids, journey, 'silver');

    expect([before, decisionsFor(await queue(ids), journey.candidateId).length]).toEqual([1, 0]);
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

/**
 * The promise, on the button the queue now points at.
 *
 * `POST /pipelines/:id/advance` had no human-review check at all. That was
 * survivable while it was a manual override and the assessment moved everybody
 * by itself; it stopped being survivable the moment a queue row started asking
 * people to press it, because the Silver → Gold press is what strikes the
 * Silver credential, in the presser's name.
 */
describe('promoting a candidate off the round the AI conducted', () => {
  beforeEach(async () => { await wipe(); });

  it('is refused while nobody has read their interview, and says where to read it', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    const { assessmentId } = await interviewed(ids, journey);

    const refused = await advance(ids, journey, 'gold');

    expect([refused.status, refused.body.code]).toEqual([409, 'human_review_required']);
    expect(refused.body.error).toContain(`/assessments/${assessmentId}`);
  });

  it('strikes no credential on the attempt it refused', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    await interviewed(ids, journey);

    await advance(ids, journey, 'gold');

    expect([await stageOf(journey), (await tiersOf(journey.candidateId)).map((a) => a.tier)])
      .toEqual(['silver', ['bronze']]);
  });

  it('records the refusal, because how the promise held is worth as much as that it did', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    await interviewed(ids, journey);

    await advance(ids, journey, 'gold');

    const refusals = await prisma.auditEvent.findMany({ where: { action: 'pipeline.advance_refused', entityId: journey.pipelineId } });
    expect(refusals.length).toBe(1);
  });

  it('goes through once a person has read it, and mints Silver then', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    const { assessmentId } = await interviewed(ids, journey);
    await review(ids, assessmentId, 'CONSIDER');

    const moved = await advance(ids, journey, 'gold');

    expect([moved.status, await stageOf(journey), (await tiersOf(journey.candidateId)).map((a) => a.tier)])
      .toEqual([200, 'gold', ['bronze', 'silver']]);
  });

  // The walk TO the AI round is not a judgement about a conversation that has
  // not happened. Gating it would strand every candidate interviewed before
  // anyone touched their pipeline, which is now the ordinary case.
  it('never blocks the walk towards that round', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await interviewed(ids, journey);

    const moved = await advance(ids, journey, 'silver');

    expect([moved.status, await stageOf(journey)]).toEqual([200, 'silver']);
  });
});

/**
 * Two candidates the award-shaped gate would have said nothing about.
 *
 * The row used to wait for the Bronze award, which is struck only when the CV
 * was read against an APPROVED scorecard. Neither of these earns one, and both
 * are reachable through the ordinary endpoints — so under that gate they would
 * have sat for ever with no prompt anywhere.
 */
describe('candidates who hold no Bronze', () => {
  beforeEach(async () => { await wipe(); });

  it('still asks about a candidate whose scorecard was never approved', async () => {
    const ids = await seeded();
    await prisma.roleScorecardVersion.updateMany({ where: { roleId: ids.roleId }, data: { status: 'draft', approvedAt: null } });
    const journey = await onboarded(ids);

    const [row] = decisionsFor(await queue(ids), journey.candidateId);

    expect([(await tiersOf(journey.candidateId)).length, row?.facts.readyBecause]).toEqual([0, 'profile_read']);
  });

  /**
   * The same candidate, approved rather than merely read.
   *
   * Proceed carries them off Participation and onto Bronze, where they have no
   * CV to be ready on — and their `review` row is gone, because the review is
   * what they have just had. Listing only the CV reading at Bronze put them
   * exactly where removing the autonomous moves put everybody else: interviewed,
   * approved, and mentioned nowhere.
   */
  it('keeps asking once a Proceed verdict has moved them on to Bronze', async () => {
    const ids = await seeded();
    const created = await request(app).post('/api/candidates').set('Authorization', ids.auth)
      .send({ fullName: 'Dev Iyer', email: 'dev.iyer@example.test', roleId: ids.roleId });
    const candidateId = created.body.candidate.id as string;
    const { assessmentId } = await interviewed(ids, { candidateId, pipelineId: '' });

    await review(ids, assessmentId, 'PROCEED');

    const pipeline = await prisma.candidatePipeline.findFirstOrThrow({ where: { candidateId } });
    const rows = await queue(ids);
    expect({
      stage: pipeline.currentStageKey,
      profiles: await prisma.candidateProfileVersion.count({ where: { candidateId } }),
      stillAsked: decisionsFor(rows, candidateId)[0]?.facts,
      reviewRowGone: rows.every((r) => r.kind !== 'review'),
    }).toEqual({
      stage: 'bronze',
      profiles: 0,
      stillAsked: { stageLabel: 'Bronze', nextStageLabel: 'Silver', readyBecause: 'interview_reviewed' },
      reviewRowGone: true,
    });
  });

  // Booking an interview needs an approved ROLE scorecard, not a candidate
  // profile, so a candidate with no CV can be interviewed and assessed while
  // their pipeline still says Participation. Before this, `interview.scheduled`
  // carried them off it; now nothing does, so the queue has to.
  it('asks about a candidate still at Participation once their interview has been read', async () => {
    const ids = await seeded();
    const created = await request(app).post('/api/candidates').set('Authorization', ids.auth)
      .send({ fullName: 'Sam Rao', email: 'sam.rao@example.test', roleId: ids.roleId });
    const candidateId = created.body.candidate.id as string;
    const { assessmentId } = await interviewed(ids, { candidateId, pipelineId: '' });
    const pipeline = await prisma.candidatePipeline.findFirstOrThrow({ where: { candidateId } });
    await review(ids, assessmentId, 'CONSIDER');

    const [row] = decisionsFor(await queue(ids), candidateId);

    expect([pipeline.currentStageKey, row?.facts])
      .toEqual(['participation', { stageLabel: 'Participation', nextStageLabel: 'Bronze', readyBecause: 'interview_reviewed' }]);
  });
});

/**
 * A second interview nobody has read.
 *
 * The row's evidence used to be "a completed review exists", which is not the
 * question the button asks: the advance is refused while ANY conducted,
 * assessed interview of theirs is unread. One read and one unread interview
 * therefore produced a row pointing at a 409 — the same shape of defect as
 * offering the promotion before any review at all.
 */
describe('a candidate with one interview read and another not', () => {
  beforeEach(async () => { await wipe(); });

  it('is taken off the queue, because the move would be refused', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    const first = await interviewed(ids, journey);
    await review(ids, first.assessmentId, 'CONSIDER');
    const asked = decisionsFor(await queue(ids), journey.candidateId).length;

    // A second round for the same candidate, assessed and left unread.
    await interviewed(ids, journey);

    const refused = await advance(ids, journey, 'gold');
    expect([asked, decisionsFor(await queue(ids), journey.candidateId).length, refused.status])
      .toEqual([1, 0, 409]);
  });
});

/**
 * The gate asks what the move would mint, not what the plan calls the stage.
 *
 * A stage plan is editable through PUT /api/roles/:id/pipeline-stages, held to
 * `role:edit_scorecard` — which a RECRUITER holds. The first version of this
 * gate looked for a stage whose kind was `ai_interview`; the award engine
 * strikes on the KEY being `silver` or `gold`. A plan that reused those keys
 * with kind `human_interview`, and had no AI-conducted stage at all, made the
 * gate say "nothing to protect here" while the award engine struck Silver.
 *
 * Driven through the real endpoints, plan included: a hand-built stage plan
 * would be the fixture writing its own input, and this is the exact shape that
 * got past a review.
 */
describe('a stage plan that mints without naming an AI round', () => {
  beforeEach(async () => { await wipe(); });

  const NO_AI_ROUND = [
    { key: 'participation', label: 'Participation', kind: 'intake' },
    { key: 'silver', label: 'Silver', kind: 'human_interview' },
    { key: 'gold', label: 'Gold', kind: 'human_interview' },
    { key: 'diamond', label: 'Diamond', kind: 'human_interview' },
  ];

  /** The plan first, because a pipeline snapshots it when it starts. */
  async function withPlan(ids: Seeded) {
    const res = await request(app).put(`/api/roles/${ids.roleId}/pipeline-stages`).set('Authorization', ids.auth)
      .send({ stages: NO_AI_ROUND });
    if (res.status !== 200) throw new Error(`stage plan refused (${res.status}): ${JSON.stringify(res.body)}`);
  }

  it('still refuses the move that would mint Silver on an unread interview', async () => {
    const ids = await seeded();
    await withPlan(ids);
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    await interviewed(ids, journey);

    const refused = await advance(ids, journey, 'gold');

    expect([refused.status, refused.body.code, (await tiersOf(journey.candidateId)).map((a) => a.tier)])
      .toEqual([409, 'human_review_required', ['bronze']]);
  });

  it('refuses the same move from the decision form, so the two paths agree', async () => {
    const ids = await seeded();
    await withPlan(ids);
    const journey = await onboarded(ids);
    await advance(ids, journey, 'silver');
    await interviewed(ids, journey);

    const refused = await request(app).post(`/api/pipelines/${journey.pipelineId}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'APPROVED', reason: REASON, stageKey: 'silver' });

    expect([refused.status, refused.body.code]).toEqual([409, 'human_review_required']);
  });
});

/**
 * The move that mints nothing, from both person-paths.
 *
 * Before the gate asked what a move earns, the button said yes to this and the
 * decision form answered 409 on the same pipeline — the same disagreement
 * between two person-paths that the one-stage clamp exists to prevent, only
 * inverted. Both now allow it, for the stated reason that moving somebody
 * towards an interview says nothing about a conversation that has not happened.
 */
describe('moving a candidate with an unread interview towards the AI round', () => {
  beforeEach(async () => { await wipe(); });

  it('goes through on the Advance button, because it mints nothing', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await interviewed(ids, journey);

    const moved = await advance(ids, journey, 'silver');

    expect([moved.status, await stageOf(journey), moved.body.awards]).toEqual([200, 'silver', []]);
  });

  it('goes through on the decision form too, so neither path is stricter', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await interviewed(ids, journey);

    const decided = await request(app).post(`/api/pipelines/${journey.pipelineId}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'APPROVED', reason: REASON, stageKey: 'bronze' });

    expect([decided.status, await stageOf(journey)]).toEqual([200, 'silver']);
  });

  // A rejection ends the journey, and rejecting somebody on an interview
  // nobody read is the thing the promise is about — so that one stays refused
  // wherever the candidate is standing.
  it('still refuses to END their journey on an interview nobody read', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);
    await interviewed(ids, journey);

    const refused = await request(app).post(`/api/pipelines/${journey.pipelineId}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'REJECTED', reason: REASON, stageKey: 'bronze' });

    expect([refused.status, refused.body.code]).toEqual([409, 'human_review_required']);
  });
});

/**
 * A stage plan that renamed everything.
 *
 * The keys are free text and `role:edit_scorecard` — which a recruiter holds —
 * is all it takes to set them. A plan whose AI round is not called `silver`
 * mints nothing on the way out of it, so a gate that asked only "would this
 * mint?" never ran: the candidate was carried off a round nobody had read, and
 * the decision path recorded an approval with `missingFor` on it. That was
 * weaker than the code before this lane touched it.
 */
describe('a stage plan whose stages are renamed', () => {
  beforeEach(async () => { await wipe(); });

  const RENAMED = [
    { key: 'apply', label: 'Apply', kind: 'intake' },
    { key: 'screen', label: 'Screen', kind: 'profile_review' },
    { key: 'ai_round', label: 'AI round', kind: 'ai_interview' },
    { key: 'panel', label: 'Panel', kind: 'human_interview' },
    { key: 'offer', label: 'Offer', kind: 'human_interview' },
  ];

  async function onRenamedPlan(ids: Seeded) {
    const plan = await request(app).put(`/api/roles/${ids.roleId}/pipeline-stages`).set('Authorization', ids.auth)
      .send({ stages: RENAMED });
    if (plan.status !== 200) throw new Error(`stage plan refused (${plan.status}): ${JSON.stringify(plan.body)}`);
    const journey = await onboarded(ids);
    await advance(ids, journey, 'ai_round');
    await interviewed(ids, journey);
    return journey;
  }

  it('refuses the move off the AI round even though it mints nothing', async () => {
    const ids = await seeded();
    const journey = await onRenamedPlan(ids);

    const refused = await advance(ids, journey, 'panel');

    expect([refused.status, refused.body.code, await stageOf(journey)])
      .toEqual([409, 'human_review_required', 'ai_round']);
  });

  it('refuses the same move from the decision form, so neither path is weaker', async () => {
    const ids = await seeded();
    const journey = await onRenamedPlan(ids);

    const refused = await request(app).post(`/api/pipelines/${journey.pipelineId}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'APPROVED', reason: REASON, stageKey: 'ai_round' });

    expect([refused.status, refused.body.code]).toEqual([409, 'human_review_required']);
  });

  // The decision path used to let this through and then record
  // `humanReview: { required: true, missingFor: ... }` on the approval it had
  // just applied — an audit trail contradicting itself about the promise.
  it('records no approval claiming a review that is still missing', async () => {
    const ids = await seeded();
    const journey = await onRenamedPlan(ids);

    await request(app).post(`/api/pipelines/${journey.pipelineId}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'APPROVED', reason: REASON, stageKey: 'ai_round' });

    const advanced = await prisma.auditEvent.findMany({ where: { action: 'pipeline.advanced', entityId: journey.pipelineId } });
    expect(advanced.some((a) => a.afterJson.includes('missingFor'))).toBe(false);
  });
});

/**
 * Finalisation is allowed to vault, and this pins why.
 *
 * The one-stage clamp is about DECISIONS: a verdict is about a round, so it
 * must not carry anybody past rounds nobody judged. Finalisation names no
 * round — it is the single act that ends the journey — and the award engine
 * mints Diamond alone for it, deliberately not the tiers it passed, so no
 * certificate claims a round that never happened.
 *
 * Asserted rather than assumed, because the clamp's comment and the reference
 * both now state the carve-out, and a claim nothing checks is the kind that
 * quietly stops being true.
 */
describe('finalising a candidate from partway up', () => {
  beforeEach(async () => { await wipe(); });

  it('reaches the last stage in one move and mints Diamond alone', async () => {
    const ids = await seeded();
    const journey = await onboarded(ids);

    const finalized = await request(app).post(`/api/pipelines/${journey.pipelineId}/finalize`)
      .set('Authorization', ids.auth).send({});

    expect([finalized.status, await stageOf(journey), (await tiersOf(journey.candidateId)).map((a) => a.tier)])
      .toEqual([200, 'diamond', ['bronze', 'diamond']]);
  });
});
