import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { finalizeInterview } from '../src/realtime/interviewEngine.js';
import { readTranscript } from './reviewGateHelpers.js';
import { parseStoredEvidence } from '../src/services/awardEvidence.js';
import { DEFAULT_STAGES } from '../src/domain/pipelineStages.js';
import { READABLE_CV } from './readableCv.js';
import {
  describeMissing, findMissingAwards, stepsOf, strikeMissingAwards, tiersEarnedBy,
} from '../src/services/awardBackfill.js';

/**
 * The credentials owed to candidates who were moved before the ladder worked.
 *
 * The damage cannot be produced by driving the endpoints any more — the code
 * that caused it is gone, which is the point. So the fixture writes the state
 * it left behind, and only that: a `pipeline.auto_advanced` event out of
 * Silver, the pipeline standing at Gold, and no Silver award. Everything else
 * — the candidate, the CV, the interview, the assessment, the reviewer's
 * verdict — is built by the real endpoints, because the award's evidence is
 * read from those rows and a hand-built fixture would prove the backfill can
 * write a certificate about nothing.
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

/**
 * A candidate whose AI interview was conducted, assessed and read by a person
 * who recorded Proceed — everything through the real endpoints, so the award's
 * evidence has real rows behind it.
 */
async function reviewed(ids: Seeded) {
  const created = await request(app).post('/api/candidates').set('Authorization', ids.auth)
    .send({ fullName: 'Pat Lee', email: 'pat.lee@example.test', roleId: ids.roleId });
  const candidateId = created.body.candidate.id as string;
  await request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', ids.auth).send({ text: READABLE_CV });

  const session = await request(app).post('/api/interviews').set('Authorization', ids.auth)
    .send({ candidateId, durationMinutes: 30, language: 'en', modules: [], approve: true });
  const sessionId = session.body.session.id as string;
  const invited = await request(app).post(`/api/interviews/${sessionId}/invite`).set('Authorization', ids.auth).send({});
  const token = invited.body.invitation.token as string;
  await request(app).post(`/api/portal/${token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${token}/start`).send({});
  for (const text of ANSWERS) await request(app).post(`/api/portal/${token}/turn`).send({ text });
  await finalizeInterview(sessionId);

  const assessment = await prisma.assessmentVersion.findFirstOrThrow({ where: { sessionId }, orderBy: { version: 'desc' } });
  await readTranscript(app, assessment.id, ids.auth);
  await request(app).post(`/api/assessments/${assessment.id}/review`).set('Authorization', ids.auth)
    .send({ verdict: 'PROCEED', reason: REASON, overrides: [] });

  const pipeline = await prisma.candidatePipeline.findFirstOrThrow({ where: { candidateId } });
  return { candidateId, pipelineId: pipeline.id, tenantId: pipeline.tenantId };
}

const EARNED_ON = new Date('2026-09-20T09:15:00.000Z');
/** A minute before the move, which is when the review that caused it finished. */
const REVIEWED_ON = new Date(EARNED_ON.getTime() - 60_000);

/**
 * What the removed code left behind: the stage written, the move audited as
 * the system's, and no award anywhere.
 *
 * The review is backdated with it. The damage being modelled is months old,
 * and the backfill will only credit a review that had FINISHED by the time of
 * the move — so a fixture leaving the review at today's clock would model a
 * candidate carried out of a round before anybody read it, which is a
 * different case and has its own test below.
 */
async function autoAdvanced(o: { tenantId: string; pipelineId: string }, from: string, to: string, at: Date) {
  await prisma.candidatePipeline.update({ where: { id: o.pipelineId }, data: { currentStageKey: to } });
  await prisma.humanReview.updateMany({ where: { status: 'COMPLETED' }, data: { createdAt: REVIEWED_ON, completedAt: REVIEWED_ON } });
  await prisma.auditEvent.create({
    data: {
      tenantId: o.tenantId, actorType: 'system', actorId: 'system',
      action: 'pipeline.auto_advanced', entityType: 'CandidatePipeline', entityId: o.pipelineId,
      beforeJson: JSON.stringify({ stage: from }),
      afterJson: JSON.stringify({ stage: to, event: 'interview.assessed', trigger: 'review.completed' }),
      createdAt: at,
    },
  });
}

/** The same damage, but recorded as a person's decision that skipped a stage. */
async function advancedSkippingSilver(o: { tenantId: string; pipelineId: string; actorId: string }, at: Date) {
  await prisma.candidatePipeline.update({ where: { id: o.pipelineId }, data: { currentStageKey: 'gold' } });
  await prisma.auditEvent.create({
    data: {
      tenantId: o.tenantId, actorType: 'user', actorId: o.actorId,
      action: 'pipeline.advanced', entityType: 'CandidatePipeline', entityId: o.pipelineId,
      beforeJson: JSON.stringify({ stage: 'bronze' }),
      afterJson: JSON.stringify({ stage: 'gold' }),
      createdAt: at,
    },
  });
}

const awardsOf = (candidateId: string) =>
  prisma.candidateAward.findMany({ where: { candidateId }, orderBy: { tier: 'asc' } });

describe('which tiers a recorded move is replayed as earning', () => {
  it('expands an advance that skipped a stage into the steps the product takes today', () => {
    expect(stepsOf(DEFAULT_STAGES, 'bronze', 'gold')).toEqual([
      { from: 'bronze', to: 'silver' },
      { from: 'silver', to: 'gold' },
    ]);
  });

  // The step matters as much as the tier: the writer re-derives what to strike
  // from the from/to it is handed, so a Silver reported against `bronze → gold`
  // is a Silver the apply run would silently not mint.
  it('recovers the Silver a Bronze-to-Gold decision passed through, and names the step that earns it', () => {
    expect(tiersEarnedBy(DEFAULT_STAGES, { action: 'pipeline.advanced', from: 'bronze', to: 'gold', at: EARNED_ON, actorId: 'u1' }))
      .toEqual([{ tier: 'silver', step: { from: 'silver', to: 'gold' } }]);
  });

  // The rule the stage-based shortcut gets wrong, and the reason this job
  // replays the trail at all. Nobody interviewed them at Gold.
  it('does not invent a Gold for a finalisation that vaulted from Silver', () => {
    expect(tiersEarnedBy(DEFAULT_STAGES, { action: 'pipeline.finalized', from: 'silver', to: 'diamond', at: EARNED_ON, actorId: 'u1' }))
      .toEqual([
        { tier: 'silver', step: { from: 'silver', to: 'diamond' } },
        { tier: 'diamond', step: { from: 'silver', to: 'diamond' } },
      ]);
  });

  it('earns nothing on the walk towards the AI round', () => {
    expect(tiersEarnedBy(DEFAULT_STAGES, { action: 'pipeline.advanced', from: 'participation', to: 'silver', at: EARNED_ON, actorId: 'u1' }))
      .toEqual([]);
  });

  it('never earns Bronze, on any move in the plan', () => {
    const every = DEFAULT_STAGES.flatMap((from) => DEFAULT_STAGES.map(
      (to) => tiersEarnedBy(DEFAULT_STAGES, { action: 'pipeline.advanced', from: from.key, to: to.key, at: EARNED_ON, actorId: 'u1' }),
    ));
    expect(every.flat().map((e) => e.tier)).not.toContain('bronze');
  });
});

describe('the credentials the backfill finds', () => {
  beforeEach(async () => { await wipe(); });

  it('owes Silver to a candidate an automatic move carried out of it', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);

    const report = await findMissingAwards({ tenantId: journey.tenantId });
    const owed = report.missing.filter((m) => m.candidateId === journey.candidateId);

    // The whole row, not just its length: a count assertion is green for a
    // report that found the wrong tier for the wrong person.
    expect(owed.map((m) => ({ tier: m.tier, name: m.candidateName, earnedOn: m.earnedOn.toISOString(), blocked: m.blocked })))
      .toEqual([{ tier: 'silver', name: 'Pat Lee', earnedOn: EARNED_ON.toISOString(), blocked: null }]);
  });

  it('credits it to the person who read the interview, because no person made the move', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);

    const [owed] = (await findMissingAwards({ tenantId: journey.tenantId })).missing;

    expect({ userId: owed.credit?.userId, because: owed.credit?.because })
      .toEqual({ userId: ids.userId, because: 'reviewed_the_interview' });
  });

  it('owes nothing once the tier is held', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);
    await strikeMissingAwards(await findMissingAwards({ tenantId: journey.tenantId }));

    const again = await findMissingAwards({ tenantId: journey.tenantId });

    expect(again.missing.filter((m) => m.candidateId === journey.candidateId)).toEqual([]);
  });

  it('reads the pipelines it was pointed at, so an empty report is not an empty database', async () => {
    const ids = await seeded();
    await reviewed(ids);

    const report = await findMissingAwards({ tenantId: ids.tenantId });

    // The guard against the whole file passing vacuously: every assertion
    // above is about a report, and a report over nothing is green.
    expect(report.pipelinesRead).toBeGreaterThan(0);
  });
});

describe('what a dry run writes', () => {
  beforeEach(async () => { await wipe(); });

  it('writes nothing at all', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);

    const before = (await awardsOf(journey.candidateId)).map((a) => a.tier);
    await findMissingAwards({ tenantId: journey.tenantId });

    expect({ before, after: (await awardsOf(journey.candidateId)).map((a) => a.tier) })
      .toEqual({ before: ['bronze'], after: ['bronze'] });
  });

  it('says who, what, when and in whose name, in one line', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);

    const [owed] = (await findMissingAwards({ tenantId: journey.tenantId })).missing;

    expect(describeMissing(owed)).toBe(
      'Silver for Pat Lee on Senior Data Engineer; '
      + `earned ${EARNED_ON.toISOString()} by pipeline.auto_advanced silver → gold; `
      + 'would be struck in the name of Demo Recruiter (reviewed the interview)',
    );
  });

  it('names the step separately when the recorded move skipped a stage', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await advancedSkippingSilver({ ...journey, actorId: ids.userId }, EARNED_ON);

    const [owed] = (await findMissingAwards({ tenantId: journey.tenantId })).missing;

    expect(describeMissing(owed)).toBe(
      'Silver for Pat Lee on Senior Data Engineer; '
      + `earned ${EARNED_ON.toISOString()} by pipeline.advanced bronze → gold (via silver → gold); `
      + 'would be struck in the name of Demo Recruiter (moved them)',
    );
  });
});

describe('what the backfill strikes', () => {
  beforeEach(async () => { await wipe(); });

  it('strikes the Silver with real evidence and a verification token', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);

    const written = await strikeMissingAwards(await findMissingAwards({ tenantId: journey.tenantId }));
    const silver = (await awardsOf(journey.candidateId)).find((a) => a.tier === 'silver');
    const read = silver ? parseStoredEvidence(silver.id, silver.evidenceJson) : null;

    expect({
      struck: written.struck.map((s) => s.tier),
      reference: silver?.reference.startsWith('QS-SLV-') ?? false,
      verifyToken: (silver?.verifyToken.length ?? 0) >= 16,
      rows: read?.kind === 'current' ? read.evidence.rows.length : 0,
      assessedBy: read?.kind === 'current' ? read.evidence.signatures.left.role : null,
    }).toEqual({
      struck: ['silver'],
      reference: true,
      verifyToken: true,
      rows: 5,
      assessedBy: 'Assessed by · subject-matter expert',
    });
  });

  // The defect this test exists for: the report named a strikeable Silver and
  // the apply run minted nothing, because the writer was handed the whole
  // bronze → gold move and re-derived no tier from it. An operator would have
  // read "1 strikeable", run --apply, and believed it repaired.
  it('actually mints the Silver it reported for a move that skipped a stage', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await advancedSkippingSilver({ ...journey, actorId: ids.userId }, EARNED_ON);

    const report = await findMissingAwards({ tenantId: journey.tenantId });
    const written = await strikeMissingAwards(report);

    expect({
      reported: report.missing.map((m) => m.tier),
      struck: written.struck.map((s) => s.tier),
      tiers: (await awardsOf(journey.candidateId)).map((a) => a.tier),
    }).toEqual({ reported: ['silver'], struck: ['silver'], tiers: ['bronze', 'silver'] });
  });

  // A certificate is read for years by people who cannot check the trail
  // behind it, and the date is the one field they can see.
  it('dates the award the day the move happened, not the day the job ran', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);

    await strikeMissingAwards(await findMissingAwards({ tenantId: journey.tenantId }));
    const silver = (await awardsOf(journey.candidateId)).find((a) => a.tier === 'silver');
    const read = silver ? parseStoredEvidence(silver.id, silver.evidenceJson) : null;
    const progressed = read?.kind === 'current' ? read.evidence.rows[read.evidence.rows.length - 1] : null;

    // The frozen row and the column have to agree: the certificate prints the
    // row, the verification page reads the column.
    expect({ awardedAt: silver?.awardedAt.toISOString(), rowWhen: progressed?.when })
      .toEqual({ awardedAt: EARNED_ON.toISOString(), rowWhen: EARNED_ON.toISOString() });
  });

  it('mints nothing on a second run', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);
    await strikeMissingAwards(await findMissingAwards({ tenantId: journey.tenantId }));

    const twice = await strikeMissingAwards(await findMissingAwards({ tenantId: journey.tenantId }));

    expect({ struck: twice.struck, tiers: (await awardsOf(journey.candidateId)).map((a) => a.tier) })
      .toEqual({ struck: [], tiers: ['bronze', 'silver'] });
  });

  it('never mints Bronze for a candidate who has none', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await prisma.candidateAward.deleteMany({ where: { candidateId: journey.candidateId } });
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);

    await strikeMissingAwards(await findMissingAwards({ tenantId: journey.tenantId }));

    // Bronze is the hiring team's reading of a CV and is never issued to the
    // candidate. A repair job that handed one out would be worse than the
    // missing Silver it was written to fix.
    expect((await awardsOf(journey.candidateId)).map((a) => a.tier)).toEqual(['silver']);
  });

  it('leaves a tier alone when nobody made the move and nobody read the interview', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    // Unfinished rather than deleted: a review row is referred to elsewhere,
    // and "somebody opened it and never recorded a verdict" is the real shape
    // of an interview nobody has read anyway.
    await prisma.humanReview.updateMany({ data: { status: 'PENDING', completedAt: null, activeForAssessmentId: null } });
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);

    const report = await findMissingAwards({ tenantId: journey.tenantId });
    const written = await strikeMissingAwards(report);

    expect({
      blocked: report.missing.map((m) => m.blocked),
      struck: written.struck,
      tiers: (await awardsOf(journey.candidateId)).map((a) => a.tier),
    }).toEqual({
      blocked: ['an automatic move, and no person had reviewed this candidate’s AI interview by then'],
      struck: [],
      tiers: ['bronze'],
    });
  });

  // The other half of the bound, and the one that puts a WRONG name on a
  // certificate rather than none: the review that carried the candidate was
  // replaced by a retake afterwards. Asking `supersededAt: null` as it reads
  // today drops it, and the query then falls through to whatever older review
  // is still unsuperseded — somebody who did not read the interview the move
  // was about.
  it('still credits the reviewer whose read was superseded only after the move', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);
    const later = new Date(EARNED_ON.getTime() + 7 * 24 * 60 * 60_000);
    await prisma.humanReview.updateMany({
      where: { status: 'COMPLETED' }, data: { supersededAt: later, supersededReason: 'retake', activeForAssessmentId: null },
    });

    const report = await findMissingAwards({ tenantId: journey.tenantId });

    expect(report.missing.map((m) => ({ tier: m.tier, credit: m.credit?.userId ?? null, because: m.credit?.because ?? null })))
      .toEqual([{ tier: 'silver', credit: ids.userId, because: 'reviewed_the_interview' }]);
  });

  // The false claim this bound exists to stop. Somebody reading a retake a
  // week after the move did not read the interview the move was about, and
  // putting their name under "assessed by" on a candidate's certificate is an
  // assertion about them as well as about the candidate.
  it('will not credit a reviewer who only read the interview after the move', async () => {
    const ids = await seeded();
    const journey = await reviewed(ids);
    await autoAdvanced(journey, 'silver', 'gold', EARNED_ON);
    const after = new Date(EARNED_ON.getTime() + 7 * 24 * 60 * 60_000);
    await prisma.humanReview.updateMany({ where: { status: 'COMPLETED' }, data: { createdAt: after, completedAt: after } });

    const report = await findMissingAwards({ tenantId: journey.tenantId });
    const written = await strikeMissingAwards(report);

    expect({
      credit: report.missing.map((m) => m.credit),
      struck: written.struck,
      tiers: (await awardsOf(journey.candidateId)).map((a) => a.tier),
    }).toEqual({ credit: [null], struck: [], tiers: ['bronze'] });
  });
});
