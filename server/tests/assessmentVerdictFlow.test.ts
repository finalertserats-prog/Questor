import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { finalizeInterview } from '../src/realtime/interviewEngine.js';
import { VERDICTS } from '../src/domain/verdict.js';

/**
 * One submit that does the work.
 *
 * A completed review used to write a row and stop: the stage, the decision on
 * the round and the export were three more things a person had to remember
 * elsewhere (council review 2.2). One submit now writes the review, carries
 * the journey, records the decision once and offers the export — and says what
 * it will do before it does it.
 *
 * Two properties are load-bearing and both are proved here rather than argued:
 * the consequence the page promises is the one the submit performs, and a
 * submit that arrives twice records one review, not two.
 */

const app = createApp();
const REASON = 'The evidence on the core competencies was clear and consistent.';

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

/** An assessed AI interview: the candidate is at Gold by the time a person reviews. */
async function assessed(ids: Seeded) {
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${ids.token}/start`).send({});
  for (const text of ANSWERS) await request(app).post(`/api/portal/${ids.token}/turn`).send({ text });
  await finalizeInterview(ids.sessionId);
  const assessment = await prisma.assessmentVersion.findFirstOrThrow({ where: { sessionId: ids.sessionId }, orderBy: { version: 'desc' } });
  const pipeline = await prisma.candidatePipeline.findFirstOrThrow({ where: { candidateId: ids.candidateId } });
  return { assessmentId: assessment.id, pipelineId: pipeline.id };
}

function load(ids: Seeded, assessmentId: string) {
  return request(app).get(`/api/assessments/${assessmentId}`).set('Authorization', ids.auth);
}

function submit(ids: Seeded, assessmentId: string, verdict: string, extra: Record<string, unknown> = {}, auth = ids.auth) {
  return request(app).post(`/api/assessments/${assessmentId}/review`).set('Authorization', auth)
    .send({ verdict, reason: REASON, overrides: [], ...extra });
}

function audits(entityId: string, action: string) {
  return prisma.auditEvent.findMany({ where: { action, entityId }, orderBy: { createdAt: 'asc' } });
}

// ---------------------------------------------------------------------------
// What the page is told before the reviewer commits
// ---------------------------------------------------------------------------

describe('the journey the assessment page reads', () => {
  beforeEach(async () => { await wipe(); });

  it('says where the candidate stands and what each verdict would do', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    const { journey } = (await load(ids, assessmentId)).body;

    expect({ stage: journey.currentStageKey, label: journey.currentStageLabel, status: journey.status })
      .toEqual({ stage: 'gold', label: 'Gold', status: 'ACTIVE' });
    expect(journey.consequences.map((c: { verdict: string }) => c.verdict)).toEqual([...VERDICTS]);
  });

  it('names the stage plan, so the page can say where a move lands', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    const { journey } = (await load(ids, assessmentId)).body;

    expect(journey.stages.map((s: { key: string }) => s.key)).toEqual(['participation', 'bronze', 'silver', 'gold', 'diamond']);
  });

  it('offers the export to a reader who may export a scored assessment', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    expect((await load(ids, assessmentId)).body.export).toEqual({ available: true, because: null });
  });
});

// ---------------------------------------------------------------------------
// The promise and the act
// ---------------------------------------------------------------------------

describe('the consequence shown beside the button', () => {
  beforeEach(async () => { await wipe(); });

  for (const verdict of VERDICTS) {
    it(`is what actually happens for ${verdict}`, async () => {
      const ids = await seeded();
      const { assessmentId } = await assessed(ids);
      const { journey } = (await load(ids, assessmentId)).body;
      const promised = journey.consequences.find((c: { verdict: string }) => c.verdict === verdict);

      const done = (await submit(ids, assessmentId, verdict)).body.journey;

      expect({ to: done.toStageKey, moves: done.moves, closes: done.closes })
        .toEqual({ to: promised.toStageKey, moves: promised.moves, closes: promised.closes });
    });
  }

  it('is still what happens when the assessed event has not caught up', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessed(ids);
    await prisma.candidatePipeline.update({ where: { id: pipelineId }, data: { currentStageKey: 'silver' } });
    const { journey } = (await load(ids, assessmentId)).body;
    const promised = journey.consequences.find((c: { verdict: string }) => c.verdict === 'PROCEED');

    const done = (await submit(ids, assessmentId, 'PROCEED')).body.journey;

    expect([promised.fromStageKey, promised.toStageKey, promised.moves]).toEqual(['silver', 'gold', true]);
    expect([done.fromStageKey, done.toStageKey, done.moves]).toEqual(['silver', 'gold', true]);
  });
});

// ---------------------------------------------------------------------------
// What the one submit does, in order
// ---------------------------------------------------------------------------

describe('one submit', () => {
  beforeEach(async () => { await wipe(); });

  it('writes the review in the one vocabulary', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    const res = await submit(ids, assessmentId, 'PROCEED');

    expect(res.body.review.verdict).toBe('PROCEED');
  });

  it('records the decision once, whether or not it moved anyone', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    await submit(ids, assessmentId, 'PROCEED');

    const [decision, ...rest] = await audits(assessmentId, 'review.decision');
    expect([JSON.parse(decision.afterJson).verdict, JSON.parse(decision.afterJson).decision, rest.length])
      .toEqual(['PROCEED', 'APPROVED', 0]);
  });

  it('ends the journey on Do not progress, and says so in the same answer', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessed(ids);

    const res = await submit(ids, assessmentId, 'DO_NOT_PROGRESS');

    expect(res.body.journey.closes).toBe('REJECTED');
    expect(await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipelineId } }))
      .toMatchObject({ status: 'DECIDED', decision: 'REJECTED' });
  });

  it('offers the export inline to whoever may export', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    expect((await submit(ids, assessmentId, 'PROCEED')).body.export).toEqual({ available: true, because: null });
  });

  it('names why the export is not on offer, rather than leaving it out', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);
    // A reviewer signs off assessments but does not push them to the ATS.
    await prisma.user.update({ where: { id: ids.userId }, data: { role: 'reviewer' } });
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });

    const res = await submit(ids, assessmentId, 'PROCEED', {}, `Bearer ${login.body.token as string}`);

    expect(res.body.export).toEqual({ available: false, because: 'no_capability' });
  });
});

describe('"Just record it"', () => {
  beforeEach(async () => { await wipe(); });

  it('writes the review without deciding the round', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessed(ids);

    await submit(ids, assessmentId, 'DO_NOT_PROGRESS', { applyToJourney: false });

    expect(await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipelineId } }))
      .toMatchObject({ status: 'ACTIVE', decision: null });
  });

  it('is recorded as the reviewer\'s choice, not as a decision that failed', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    await submit(ids, assessmentId, 'DO_NOT_PROGRESS', { applyToJourney: false });

    const [decision] = await audits(assessmentId, 'review.decision');
    expect(JSON.parse(decision.afterJson)).toMatchObject({ verdict: 'DO_NOT_PROGRESS', applied: false, closed: null });
  });

  it('still records the review itself', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    await submit(ids, assessmentId, 'DO_NOT_PROGRESS', { applyToJourney: false });

    expect(await prisma.humanReview.count({ where: { assessmentId, status: 'COMPLETED' } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Arriving twice
// ---------------------------------------------------------------------------

const SUBMISSION = 'submit-0123456789abcdef';

describe('a submit that arrives twice', () => {
  beforeEach(async () => { await wipe(); });

  it('records one review, not two', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    await submit(ids, assessmentId, 'PROCEED', { submissionId: SUBMISSION });
    await submit(ids, assessmentId, 'PROCEED', { submissionId: SUBMISSION });

    expect(await prisma.humanReview.count({ where: { assessmentId, status: 'COMPLETED' } })).toBe(1);
  });

  it('answers the retry with the first submit\'s review rather than a refusal', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    const first = await submit(ids, assessmentId, 'PROCEED', { submissionId: SUBMISSION });
    const retry = await submit(ids, assessmentId, 'PROCEED', { submissionId: SUBMISSION });

    expect([retry.status, retry.body.review.id, retry.body.replayed]).toEqual([200, first.body.review.id, true]);
  });

  it('decides the round once', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);

    await submit(ids, assessmentId, 'DO_NOT_PROGRESS', { submissionId: SUBMISSION });
    await submit(ids, assessmentId, 'DO_NOT_PROGRESS', { submissionId: SUBMISSION });

    expect((await audits(assessmentId, 'review.decision')).length).toBe(1);
  });

  it('refuses a submission id that belongs to another assessment', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessed(ids);
    await submit(ids, assessmentId, 'PROCEED', { submissionId: SUBMISSION });
    const other = await prisma.assessmentVersion.create({
      data: {
        sessionId: ids.sessionId, scorecardId: (await prisma.assessmentVersion.findFirstOrThrow({ where: { sessionId: ids.sessionId } })).scorecardId,
        version: 99, recommendation: 'CONSIDER', resultJson: JSON.stringify({ overallScore: 50, competencies: [] }),
      },
    });

    const res = await submit(ids, other.id, 'PROCEED', { submissionId: SUBMISSION });

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// The race. Loops, because a race that passes once has not been shown to be safe.
// ---------------------------------------------------------------------------

describe('submits racing each other', () => {
  beforeEach(async () => { await wipe(); });

  it('records one review however many copies of one submit arrive at once', async () => {
    for (let round = 0; round < 6; round++) {
      const ids = await seeded();
      const { assessmentId } = await assessed(ids);
      const submission = `race-${round}-0123456789`;

      const results = await Promise.all(
        Array.from({ length: 5 }, () => submit(ids, assessmentId, 'PROCEED', { submissionId: submission })),
      );

      expect([
        round,
        await prisma.humanReview.count({ where: { assessmentId, status: 'COMPLETED' } }),
        results.filter((r) => r.status >= 400).length,
        new Set(results.map((r) => r.body.review?.id)).size,
      ]).toEqual([round, 1, 0, 1]);
    }
  }, 120_000);

  it('never advances the candidate twice, even when the submits differ', async () => {
    for (let round = 0; round < 6; round++) {
      const ids = await seeded();
      const { assessmentId, pipelineId } = await assessed(ids);
      await prisma.candidatePipeline.update({ where: { id: pipelineId }, data: { currentStageKey: 'silver' } });

      await Promise.all(
        Array.from({ length: 4 }, (_, i) => submit(ids, assessmentId, 'PROCEED', { submissionId: `wave-${round}-${i}-abcdefgh` })),
      );

      // Gold is where an assessed AI interview lands. Nothing here may carry
      // them past it: the human rounds are still to come.
      expect([round, (await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipelineId } })).currentStageKey])
        .toEqual([round, 'gold']);
    }
  }, 120_000);

  it('lets exactly one of a racing pair record the review', async () => {
    for (let round = 0; round < 6; round++) {
      const ids = await seeded();
      const { assessmentId } = await assessed(ids);

      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) => submit(ids, assessmentId, 'PROCEED', { submissionId: `solo-${round}-${i}-abcdefgh` })),
      );

      expect([round, results.filter((r) => r.status === 201).length, await prisma.humanReview.count({ where: { assessmentId, status: 'COMPLETED', supersededAt: null } })])
        .toEqual([round, 1, 1]);
    }
  }, 120_000);
});
