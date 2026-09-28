import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { readTranscript } from './reviewGateHelpers.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { finalizeInterview } from '../src/realtime/interviewEngine.js';

/**
 * Decisions drive the pipeline, and past Bronze they are the ONLY thing that
 * does. A person approves, rejects or records a withdrawal — on the pipeline
 * itself, or as the verdict on an assessment review — and the candidate's
 * pipeline and journey follow without a second action: approval moves them to
 * the next stage (Silver → Gold, Gold → Diamond), and that move is what
 * strikes the tier they are leaving; rejection and withdrawal close the
 * pipeline with that outcome, at the stage the candidate actually stands at.
 * Nothing here moves anyone backwards, and a decided pipeline stays decided.
 */

const app = createApp();
const OTHER_PASSWORD = 'other-org-correct-horse-battery';
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

interface PipelineBody {
  id: string;
  currentStageKey: string;
  status: string;
  decision: string | null;
  decisionReason: string | null;
  decidedAtStageKey: string | null;
}

async function pipelineAt(ids: Seeded, stage: string): Promise<PipelineBody> {
  const created = await request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId: ids.candidateId });
  const id = created.body.pipeline.id as string;
  const stages = ['participation', 'bronze', 'silver', 'gold', 'diamond'];
  for (const key of stages.slice(1, stages.indexOf(stage) + 1)) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: key });
  }
  return (await request(app).get(`/api/pipelines/${id}`).set('Authorization', ids.auth)).body.pipeline as PipelineBody;
}

/** The stage travels with the decision, as the panel sends it; `extra` may name a different one. */
function decide(ids: Seeded, pipeline: PipelineBody, decision: string, extra: Record<string, unknown> = {}, auth = ids.auth) {
  return request(app).post(`/api/pipelines/${pipeline.id}/decision`).set('Authorization', auth)
    .send({ decision, reason: REASON, stageKey: pipeline.currentStageKey, ...extra });
}

async function stored(id: string) {
  return prisma.candidatePipeline.findUniqueOrThrow({ where: { id } });
}

async function audits(id: string, action: string) {
  return prisma.auditEvent.findMany({ where: { action, entityId: id }, orderBy: { createdAt: 'asc' } });
}

describe('approving on the pipeline', () => {
  beforeEach(async () => { await wipe(); });

  it('moves a Silver candidate to Gold and keeps the pipeline open', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');

    const res = await decide(ids, pipeline, 'APPROVED');

    expect(res.body.pipeline).toMatchObject({ status: 'ACTIVE', currentStageKey: 'gold', decision: null });
  });

  it('reports the move it made', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');

    const res = await decide(ids, pipeline, 'APPROVED');

    expect(res.body.effect).toEqual({ kind: 'advance', from: 'silver', to: 'gold', final: false });
  });

  it('moves a Gold candidate to Diamond without the Finalise button', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'gold');

    const res = await decide(ids, pipeline, 'APPROVED');

    expect(res.body.pipeline).toMatchObject({ status: 'ACTIVE', currentStageKey: 'diamond' });
  });

  it('records reaching Diamond as a finalisation by the person who approved, from the pipeline', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'gold');
    await decide(ids, pipeline, 'APPROVED');

    const [finalized] = await audits(pipeline.id, 'pipeline.finalized');

    expect({ actorType: finalized.actorType, actorId: finalized.actorId, after: JSON.parse(finalized.afterJson) })
      .toEqual({
        actorType: 'user', actorId: ids.userId,
        // humanReview travels with every decision now: this candidate's
        // interview never produced an assessment, so there was nothing for
        // anyone to read — and the trail says that rather than saying nothing.
        after: { stage: 'diamond', decision: 'APPROVED', source: 'pipeline', trigger: 'pipeline.decision', humanReview: { required: false, because: 'no_assessment' } },
      });
  });

  it('closes a Diamond candidate as approved', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'diamond');

    const res = await decide(ids, pipeline, 'APPROVED');

    expect(res.body.pipeline).toMatchObject({ status: 'DECIDED', decision: 'APPROVED', decidedAtStageKey: 'diamond' });
  });

  it('audits an ordinary move as an advance carrying the decision', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'bronze');
    await decide(ids, pipeline, 'APPROVED');

    const advances = await audits(pipeline.id, 'pipeline.advanced');

    expect(JSON.parse(advances[advances.length - 1].afterJson))
      .toEqual({ stage: 'silver', decision: 'APPROVED', source: 'pipeline', trigger: 'pipeline.decision', humanReview: { required: false, because: 'no_assessment' } });
  });

  it('refuses a decision about a stage the candidate has already left', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'gold');

    const res = await decide(ids, pipeline, 'APPROVED', { stageKey: 'silver' });

    expect([res.status, (await stored(pipeline.id)).currentStageKey]).toEqual([409, 'gold']);
  });

  it('refuses a decision that does not say which stage it is about', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');

    const res = await request(app).post(`/api/pipelines/${pipeline.id}/decision`).set('Authorization', ids.auth).send({ decision: 'APPROVED', reason: REASON });

    expect([res.status, (await stored(pipeline.id)).currentStageKey]).toEqual([400, 'silver']);
  });

  it('does not move a candidate twice when an approval is retried', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');
    await decide(ids, pipeline, 'APPROVED');

    const retry = await decide(ids, pipeline, 'APPROVED');

    expect([retry.status, (await stored(pipeline.id)).currentStageKey]).toEqual([409, 'gold']);
  });

  it('accepts a decision scoped to the stage the candidate is at', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');

    const res = await decide(ids, pipeline, 'APPROVED', { stageKey: 'silver' });

    expect(res.body.pipeline.currentStageKey).toBe('gold');
  });
});

describe('rejecting or withdrawing on the pipeline', () => {
  beforeEach(async () => { await wipe(); });

  it('closes the pipeline as rejected at the stage the candidate is at', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');

    const res = await decide(ids, pipeline, 'REJECTED');

    expect(res.body.pipeline).toMatchObject({ status: 'DECIDED', decision: 'REJECTED', decidedAtStageKey: 'silver', decisionReason: REASON });
  });

  it('closes the pipeline as withdrawn', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'bronze');

    const res = await decide(ids, pipeline, 'WITHDRAWN');

    expect(res.body.pipeline).toMatchObject({ status: 'DECIDED', decision: 'WITHDRAWN', decidedAtStageKey: 'bronze' });
  });

  it('audits the decision with where it came from, and without the reason text', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');
    await decide(ids, pipeline, 'REJECTED');

    const [decided] = await audits(pipeline.id, 'pipeline.decided');

    expect({ actorId: decided.actorId, after: JSON.parse(decided.afterJson), hasReason: decided.afterJson.includes(REASON) })
      .toEqual({
        actorId: ids.userId, hasReason: false,
        after: { decision: 'REJECTED', stage: 'silver', about: 'silver', source: 'pipeline', trigger: 'pipeline.decision', reasonRecorded: true, humanReview: { required: false, because: 'no_assessment' } },
      });
  });

  it('refuses a second decision on a decided pipeline with 409 and changes nothing', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');
    await decide(ids, pipeline, 'REJECTED');

    const again = await decide(ids, pipeline, 'APPROVED');

    expect([again.status, (await stored(pipeline.id)).decision]).toEqual([409, 'REJECTED']);
  });

  it('is not visible to another organisation', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');
    const other = await request(app).post('/api/auth/register').send({ email: 'hr@other.local', password: OTHER_PASSWORD, name: 'Other HR', tenantName: 'Other Org' });

    const res = await decide(ids, pipeline, 'REJECTED', {}, `Bearer ${other.body.token as string}`);

    expect([res.status, (await stored(pipeline.id)).status]).toEqual([404, 'ACTIVE']);
  });

  it('lets exactly one of two concurrent decisions land', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'silver');

    const results = await Promise.all([decide(ids, pipeline, 'REJECTED'), decide(ids, pipeline, 'WITHDRAWN')]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  // A rejection recorded at Gold while someone else finalises must not close
  // the candidate at Diamond, a stage nobody judged: one of the two wins and
  // the other is told to reload.
  it('never closes a candidate at a stage a concurrent Finalise moved them to', async () => {
    const ids = await seeded();
    const pipeline = await pipelineAt(ids, 'gold');

    const [finalized, rejected] = await Promise.all([
      request(app).post(`/api/pipelines/${pipeline.id}/finalize`).set('Authorization', ids.auth).send({}),
      decide(ids, pipeline, 'REJECTED'),
    ]);
    const after = await stored(pipeline.id);

    expect([finalized.status, rejected.status].sort()).toEqual([200, 409]);
    expect([after.status, after.decidedAtStageKey]).not.toEqual(['DECIDED', 'diamond']);
  });
});

/**
 * An assessed AI interview, with the candidate standing at the round it was
 * conducted for.
 *
 * Walking them to Silver is a person's decision now and nothing else will make
 * it (domain/pipelineAutonomy.ts), so this presses Advance the way a recruiter
 * has to. Without it the candidate sits at Participation through their own
 * interview, and every verdict below would be judging a round the pipeline
 * says they never reached.
 */
async function assessedInterview(ids: Seeded) {
  const walked = await pipelineAt(ids, 'silver');
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${ids.token}/start`).send({});
  for (const text of ANSWERS) await request(app).post(`/api/portal/${ids.token}/turn`).send({ text });
  await finalizeInterview(ids.sessionId);
  const assessment = await prisma.assessmentVersion.findFirstOrThrow({ where: { sessionId: ids.sessionId }, orderBy: { version: 'desc' } });
  return { assessmentId: assessment.id, pipelineId: walked.id };
}

async function review(ids: Seeded, assessmentId: string, disposition: string, extra: Record<string, unknown> = {}) {
  // A verdict is refused from a reviewer with no record of having read the
  // interview; reading it is what makes the decision below permissible.
  await readTranscript(app, assessmentId, ids.auth);
  return request(app).post(`/api/assessments/${assessmentId}/review`).set('Authorization', ids.auth)
    .send({ verdict: disposition, reason: REASON, overrides: [], ...extra });
}

describe('the verdict on an assessment review', () => {
  beforeEach(async () => { await wipe(); });

  it('PROCEED leaves the candidate at Gold, ready for human rounds, with the pipeline open', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessedInterview(ids);

    await review(ids, assessmentId, 'PROCEED');

    expect(await stored(pipelineId)).toMatchObject({ status: 'ACTIVE', currentStageKey: 'gold' });
  });

  // Nothing carries a candidate to Silver by itself any more, so one can be
  // interviewed while their pipeline still says Bronze. Proceed brings them up
  // to the round that was judged and no further: carrying them to Gold would
  // skip Silver, and a tier nobody is promoted out of is a tier nobody is ever
  // struck.
  it('PROCEED brings a candidate the pipeline left behind up to Silver, and no further', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessedInterview(ids);
    await prisma.candidatePipeline.update({ where: { id: pipelineId }, data: { currentStageKey: 'bronze' } });

    await review(ids, assessmentId, 'PROCEED');

    expect((await stored(pipelineId)).currentStageKey).toBe('silver');
  });

  it('PROCEED never moves a candidate past Gold: the human rounds are still to come', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessedInterview(ids);

    await review(ids, assessmentId, 'PROCEED');

    // The walk to Silver was pressed by a person too, so the trail holds those
    // moves as well; what this is about is where the verdict left them.
    const advances = (await audits(pipelineId, 'pipeline.advanced')).map((a) => JSON.parse(a.afterJson).stage as string);
    expect([advances[advances.length - 1], await audits(pipelineId, 'pipeline.finalized')]).toEqual(['gold', []]);
  });

  it('DO_NOT_PROGRESS closes the pipeline as rejected with the reviewer\'s reason', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessedInterview(ids);

    await review(ids, assessmentId, 'DO_NOT_PROGRESS');

    expect(await stored(pipelineId)).toMatchObject({ status: 'DECIDED', decision: 'REJECTED', decisionReason: REASON, decidedById: ids.userId });
  });

  it('DO_NOT_PROGRESS is audited as a decision that came from the review', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessedInterview(ids);

    await review(ids, assessmentId, 'DO_NOT_PROGRESS');

    const [decided] = await audits(pipelineId, 'pipeline.decided');
    expect({ actorType: decided.actorType, actorId: decided.actorId, after: JSON.parse(decided.afterJson) })
      .toEqual({
        actorType: 'user', actorId: ids.userId,
        // The interview this verdict is about was read: that is what the
        // candidate's consent screen promised, and it is on the decision.
        // Closed at Silver, which is where the candidate actually stands: the
        // assessment no longer carries anyone to Gold, and a journey must not
        // end at a stage nobody moved them to.
        after: { decision: 'REJECTED', stage: 'silver', about: 'silver', source: 'review', trigger: 'review.completed', reasonRecorded: true, humanReview: { required: true, satisfiedBy: [assessmentId] } },
      });
  });

  it('reports what the review did to the pipeline', async () => {
    const ids = await seeded();
    const { assessmentId } = await assessedInterview(ids);

    const res = await review(ids, assessmentId, 'DO_NOT_PROGRESS');

    expect(res.body.journey).toMatchObject({ fromStageKey: 'silver', toStageKey: 'silver', moves: false, closes: 'REJECTED' });
  });

  it('CONSIDER decides nothing', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessedInterview(ids);

    const res = await review(ids, assessmentId, 'CONSIDER');

    expect([res.status, (await stored(pipelineId)).status, res.body.journey.closes]).toEqual([201, 'ACTIVE', null]);
  });

  it('never reopens a decided pipeline when a later review supersedes the verdict', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessedInterview(ids);
    await review(ids, assessmentId, 'DO_NOT_PROGRESS');

    const res = await review(ids, assessmentId, 'PROCEED', { supersede: { reason: 'A second reviewer read the transcript differently.' } });

    expect([res.status, (await stored(pipelineId)).decision]).toEqual([201, 'REJECTED']);
    expect(res.body.journey).toMatchObject({ toStageKey: 'silver', moves: false, closes: null });
  });

  it('still records the review when the pipeline plan is corrupt', async () => {
    const ids = await seeded();
    const { assessmentId, pipelineId } = await assessedInterview(ids);
    await prisma.candidatePipeline.update({ where: { id: pipelineId }, data: { stagesJson: '{not-json' } });

    const res = await review(ids, assessmentId, 'DO_NOT_PROGRESS');

    expect([res.status, await prisma.humanReview.count({ where: { assessmentId } })]).toEqual([201, 1]);
  });
});
