import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { HUMAN_REVIEW_REQUIRED } from '../src/domain/humanReviewRule.js';
import { assessmentReviewRequirement, humanReviewCheck } from '../src/services/humanReviewGate.js';
import { readTranscript } from './reviewGateHelpers.js';
import { installFakeAts } from './fakeAts.js';

/**
 * "A person on the hiring team reviews the interview."
 *
 * The candidate reads that before they consent, and until now it was true only
 * because people generally did it. These are the paths that record what
 * happens to a candidate, held to it: the decision endpoint, the verdict that
 * carries a decision, finalisation, and the export that puts the AI's reading
 * into the ATS where it outlives this application.
 *
 * Just as important is what is NOT blocked. A candidate with no AI interview,
 * one who withdrew, one whose interview broke, and one who consented before
 * this rule existed all have to stay closeable — a compliance rule that strands
 * people in a pipeline is a worse failure than the one it fixes.
 */

const app = createApp();
const REASON = 'The evidence on the core competencies was clear and consistent.';
const RESULT = {
  recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, overallScore: 70,
  competencies: [], strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
};

async function seeded() {
  const ids = await createDemoData();
  const auth = `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}`;
  return { ...ids, auth };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;

/** An AI interview that got as far as an assessment: the thing a person owes a reading of. */
async function assessed(ids: Seeded, sessionId = ids.sessionId): Promise<string> {
  await prisma.interviewSession.update({ where: { id: sessionId }, data: { state: 'REVIEW_READY' } });
  await prisma.turn.createMany({
    data: [
      { sessionId, index: 0, speaker: 'agent', text: 'Tell me about an incident you owned.' },
      { sessionId, index: 1, speaker: 'candidate', text: 'I led the rollback and made recovery idempotent.' },
    ],
  });
  const assessment = await prisma.assessmentVersion.create({
    data: { sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, resultJson: JSON.stringify(RESULT) },
  });
  return assessment.id;
}

/**
 * The candidate's pipeline, parked at a stage.
 *
 * Create-or-fetch rather than create: recording a review raises
 * `interview.assessed`, which starts the pipeline itself, so a spec that
 * reviewed first would otherwise collide with its own fixture. The stage is
 * set directly because stage arithmetic is pipelineAutonomy's subject, not
 * this file's — here it is only the place the candidate is standing.
 */
async function pipelineAt(ids: Seeded, stage: string, candidateId = ids.candidateId) {
  const existing = await prisma.candidatePipeline.findFirst({ where: { tenantId: ids.tenantId, candidateId } });
  const id = existing?.id ?? (await request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId })).body.pipeline.id as string;
  await prisma.candidatePipeline.update({ where: { id }, data: { currentStageKey: stage, status: 'ACTIVE' } });
  return { id, currentStageKey: stage };
}

/** Somebody on the same role who never sat an AI interview. */
async function candidateWithoutInterview(ids: Seeded): Promise<string> {
  const candidate = await prisma.candidate.create({
    data: {
      tenantId: ids.tenantId, roleId: ids.roleId, fullName: 'Noor Haddad',
      email: 'noor.haddad@example.com', emailNormalized: 'noor.haddad@example.com', phone: '',
    },
  });
  return candidate.id;
}

function decide(ids: Seeded, pipeline: { id: string; currentStageKey: string }, decision: string) {
  return request(app).post(`/api/pipelines/${pipeline.id}/decision`).set('Authorization', ids.auth)
    .send({ decision, reason: REASON, stageKey: pipeline.currentStageKey });
}

/** A completed review of the assessment — the promise, kept. */
async function reviewed(ids: Seeded, assessmentId: string) {
  await readTranscript(app, assessmentId, ids.auth);
  const res = await request(app).post(`/api/assessments/${assessmentId}/review`).set('Authorization', ids.auth)
    .send({ verdict: 'CONSIDER', reason: REASON, applyToJourney: false });
  if (res.status !== 201) throw new Error(`review refused (${res.status}): ${JSON.stringify(res.body)}`);
}

/** Consent as it was recorded before this rule existed: no flag at all. */
async function consentWithoutFlag(sessionId: string) {
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId }, select: { consentJson: true } });
  const consent = JSON.parse(session.consentJson) as Record<string, unknown>;
  delete consent.humanReviewRequired;
  await prisma.interviewSession.update({ where: { id: sessionId }, data: { consentJson: JSON.stringify(consent) } });
}

beforeEach(async () => { await wipe(); });

describe('a decision on an AI interview nobody has reviewed', () => {
  it('is refused', async () => {
    const ids = await seeded();
    await assessed(ids);
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(409);
  });

  it('is refused for a rejection too — that is the decision the promise is about', async () => {
    const ids = await seeded();
    await assessed(ids);
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'REJECTED');
    expect(res.status).toBe(409);
  });

  it('says what the candidate was promised, rather than naming a permission', async () => {
    const ids = await seeded();
    await assessed(ids);
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.body.error).toContain('a person on the hiring team would review their interview');
  });

  it('links to the review that is missing', async () => {
    const ids = await seeded();
    const assessmentId = await assessed(ids);
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.body.error).toContain(`/assessments/${assessmentId}`);
  });

  it('carries a code the page can act on', async () => {
    const ids = await seeded();
    await assessed(ids);
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.body.code).toBe(HUMAN_REVIEW_REQUIRED);
  });

  it('leaves the pipeline exactly where it was', async () => {
    const ids = await seeded();
    await assessed(ids);
    const pipeline = await pipelineAt(ids, 'silver');
    await decide(ids, pipeline, 'APPROVED');
    const stored = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } });
    expect(stored).toMatchObject({ status: 'ACTIVE', currentStageKey: 'silver', decision: null });
  });

  // An attempt to decide an interview nobody read is exactly what an Art. 14
  // oversight audit asks about; a refusal that leaves no trace answers with
  // silence.
  it('records the attempt in the audit trail', async () => {
    const ids = await seeded();
    await assessed(ids);
    const pipeline = await pipelineAt(ids, 'silver');
    await decide(ids, pipeline, 'APPROVED');
    const refusals = await prisma.auditEvent.findMany({ where: { action: 'pipeline.decision_refused', entityId: pipeline.id } });
    expect(refusals).toHaveLength(1);
    expect(JSON.parse(refusals[0].afterJson) as Record<string, unknown>).toMatchObject({ because: HUMAN_REVIEW_REQUIRED, decision: 'APPROVED' });
  });
});

describe('once a person has reviewed it', () => {
  it('lets the decision through', async () => {
    const ids = await seeded();
    await reviewed(ids, await assessed(ids));
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(200);
  });

  it('moves the candidate on, as it always did', async () => {
    const ids = await seeded();
    await reviewed(ids, await assessed(ids));
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.body.pipeline).toMatchObject({ currentStageKey: 'gold', status: 'ACTIVE' });
  });

  // Without this the record cannot tell an exempt candidate from one whose
  // review was simply never checked.
  it('records on the decision that the promise applied and was kept', async () => {
    const ids = await seeded();
    const assessmentId = await assessed(ids);
    await reviewed(ids, assessmentId);
    const pipeline = await pipelineAt(ids, 'silver');
    await decide(ids, pipeline, 'REJECTED');
    const [decided] = await prisma.auditEvent.findMany({ where: { action: 'pipeline.decided', entityId: pipeline.id } });
    expect((JSON.parse(decided.afterJson) as { humanReview: unknown }).humanReview)
      .toEqual({ required: true, satisfiedBy: [assessmentId] });
  });

  it('does not accept a review that was superseded and left unreplaced', async () => {
    const ids = await seeded();
    const assessmentId = await assessed(ids);
    await reviewed(ids, assessmentId);
    await prisma.humanReview.updateMany({ where: { assessmentId }, data: { supersededAt: new Date(), activeForAssessmentId: null } });
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(409);
  });
});

describe('the candidates this must not block', () => {
  it('lets a candidate with no AI interview at all be decided', async () => {
    const ids = await seeded();
    await assessed(ids);
    const other = await candidateWithoutInterview(ids);
    const res = await decide(ids, await pipelineAt(ids, 'bronze', other), 'APPROVED');
    expect(res.status).toBe(200);
  });

  it('lets a candidate whose interview produced no assessment be decided', async () => {
    const ids = await seeded();
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(200);
  });

  it('lets a withdrawal be recorded even on an unreviewed interview', async () => {
    const ids = await seeded();
    await assessed(ids);
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'WITHDRAWN');
    expect(res.status).toBe(200);
  });

  it('closes a candidate who withdrew from the interview itself', async () => {
    const ids = await seeded();
    await assessed(ids);
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'CANDIDATE_WITHDREW' } });
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'REJECTED');
    expect(res.status).toBe(200);
  });

  it('closes a candidate whose interview broke', async () => {
    const ids = await seeded();
    await assessed(ids);
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'TECHNICAL_FAILURE' } });
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(200);
  });

  it('closes a candidate whose interview never finished', async () => {
    const ids = await seeded();
    await assessed(ids);
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'INCOMPLETE' } });
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(200);
  });

  // The whole reason the flag is read rather than assumed: nobody promised
  // these candidates a review, and refusing to close them out would punish
  // them for a rule written after their interview.
  it('does not apply to an interview consented before the rule existed', async () => {
    const ids = await seeded();
    await assessed(ids);
    await consentWithoutFlag(ids.sessionId);
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(200);
  });

  it('records why such a decision was exempt', async () => {
    const ids = await seeded();
    await assessed(ids);
    await consentWithoutFlag(ids.sessionId);
    const pipeline = await pipelineAt(ids, 'silver');
    await decide(ids, pipeline, 'REJECTED');
    const [decided] = await prisma.auditEvent.findMany({ where: { action: 'pipeline.decided', entityId: pipeline.id } });
    expect((JSON.parse(decided.afterJson) as { humanReview: unknown }).humanReview).toEqual({ required: false, because: 'not_recorded' });
  });

  it('honours an interview created with human review turned off', async () => {
    const ids = await seeded();
    await assessed(ids);
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId }, select: { consentJson: true } });
    const consent = { ...(JSON.parse(session.consentJson) as Record<string, unknown>), humanReviewRequired: false };
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { consentJson: JSON.stringify(consent) } });
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(200);
  });
});

describe('finalising', () => {
  it('is refused while an AI interview is unreviewed', async () => {
    const ids = await seeded();
    await assessed(ids);
    const pipeline = await pipelineAt(ids, 'gold');
    const res = await request(app).post(`/api/pipelines/${pipeline.id}/finalize`).set('Authorization', ids.auth).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(HUMAN_REVIEW_REQUIRED);
  });

  it('records the refusal', async () => {
    const ids = await seeded();
    await assessed(ids);
    const pipeline = await pipelineAt(ids, 'gold');
    await request(app).post(`/api/pipelines/${pipeline.id}/finalize`).set('Authorization', ids.auth).send({});
    const refusals = await prisma.auditEvent.findMany({ where: { action: 'pipeline.finalize_refused', entityId: pipeline.id } });
    expect(refusals).toHaveLength(1);
  });

  it('goes through once the review exists', async () => {
    const ids = await seeded();
    await reviewed(ids, await assessed(ids));
    const pipeline = await pipelineAt(ids, 'gold');
    const res = await request(app).post(`/api/pipelines/${pipeline.id}/finalize`).set('Authorization', ids.auth).send({});
    expect(res.body.pipeline).toMatchObject({ currentStageKey: 'diamond' });
  });

  it('is untouched for a candidate with no AI interview', async () => {
    const ids = await seeded();
    await assessed(ids);
    const pipeline = await pipelineAt(ids, 'gold', await candidateWithoutInterview(ids));
    const res = await request(app).post(`/api/pipelines/${pipeline.id}/finalize`).set('Authorization', ids.auth).send({});
    expect(res.status).toBe(200);
  });
});

describe('a second interview', () => {
  async function secondSession(ids: Seeded, data: Record<string, unknown> = {}) {
    const first = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    const created = await prisma.interviewSession.create({
      data: {
        tenantId: first.tenantId, candidateId: first.candidateId, roleId: first.roleId, scorecardId: first.scorecardId,
        state: 'ACCEPTED', consentJson: first.consentJson, personaJson: first.personaJson, ...data,
      },
    });
    return created.id;
  }

  // Otherwise booking a retake would be the way around the rule.
  it('does not excuse the first one nobody read', async () => {
    const ids = await seeded();
    await assessed(ids);
    await secondSession(ids);
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(409);
  });

  it('is itself owed a review when it has been assessed', async () => {
    const ids = await seeded();
    await reviewed(ids, await assessed(ids));
    const second = await secondSession(ids);
    await assessed(ids, second);
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(409);
  });

  // A retake replaces the attempt; the retake is the one that must be read.
  it('excuses the attempt it replaced when it is a retake', async () => {
    const ids = await seeded();
    await assessed(ids);
    const retake = await secondSession(ids, { retakeOfSessionId: ids.sessionId, attemptNumber: 2 });
    await reviewed(ids, await assessed(ids, retake));
    const res = await decide(ids, await pipelineAt(ids, 'silver'), 'APPROVED');
    expect(res.status).toBe(200);
  });
});

describe('the export to the ATS', () => {
  // The ATS is the system of record: once the AI's reading is in it, it is a
  // hiring signal that outlives this application and that nobody downstream can
  // trace back to whether a person ever read the interview.
  async function connectedAts(ids: Seeded, assessmentId: string) {
    const fake = installFakeAts({ 'ats-x.example.com': { candidates: { 'C-1': { fullName: 'Priya Sharma' } } } });
    await request(app).put('/api/admin/ats').set('Authorization', ids.auth)
      .send({ baseUrl: 'https://ats-x.example.com/api', apiKey: 'ats-key-MARKER-never-echo' });
    const connection = await prisma.atsConnection.findFirstOrThrow({ where: { tenantId: ids.tenantId } });
    await prisma.candidateAtsLink.create({
      data: { tenantId: ids.tenantId, candidateId: ids.candidateId, connectionId: connection.id, externalCandidateId: 'C-1' },
    });
    return { fake, assessmentId };
  }

  it('is refused while nobody has reviewed the interview', async () => {
    const ids = await seeded();
    const assessmentId = await assessed(ids);
    await connectedAts(ids, assessmentId);
    const res = await request(app).post(`/api/assessments/${assessmentId}/export`).set('Authorization', ids.auth).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(HUMAN_REVIEW_REQUIRED);
  });

  it('sends nothing to the ATS when it refuses', async () => {
    const ids = await seeded();
    const assessmentId = await assessed(ids);
    const { fake } = await connectedAts(ids, assessmentId);
    await request(app).post(`/api/assessments/${assessmentId}/export`).set('Authorization', ids.auth).send({});
    expect(fake.calls.filter((c) => c.method === 'POST' && c.url.pathname.includes('assessment'))).toHaveLength(0);
  });

  it('records the refusal', async () => {
    const ids = await seeded();
    const assessmentId = await assessed(ids);
    await connectedAts(ids, assessmentId);
    await request(app).post(`/api/assessments/${assessmentId}/export`).set('Authorization', ids.auth).send({});
    expect(await prisma.auditEvent.count({ where: { action: 'assessment.export_refused', entityId: assessmentId } })).toBe(1);
  });

  it('goes through once the review exists', async () => {
    const ids = await seeded();
    const assessmentId = await assessed(ids);
    await reviewed(ids, assessmentId);
    await connectedAts(ids, assessmentId);
    const res = await request(app).post(`/api/assessments/${assessmentId}/export`).set('Authorization', ids.auth).send({});
    expect(res.status).toBe(200);
  });
});

describe('two decisions racing', () => {
  // The gate is a read before a conditional write. It must not become a second
  // way for a candidate to be decided twice, and it must not turn one of two
  // simultaneous decisions into a "you did not review this" that is untrue.
  it('still lets exactly one of two simultaneous decisions land', async () => {
    const ids = await seeded();
    await reviewed(ids, await assessed(ids));
    const pipeline = await pipelineAt(ids, 'silver');
    const [a, b] = await Promise.all([decide(ids, pipeline, 'REJECTED'), decide(ids, pipeline, 'APPROVED')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('refuses both when neither could have reviewed it', async () => {
    const ids = await seeded();
    await assessed(ids);
    const pipeline = await pipelineAt(ids, 'silver');
    const [a, b] = await Promise.all([decide(ids, pipeline, 'REJECTED'), decide(ids, pipeline, 'APPROVED')]);
    expect([a.status, b.status]).toEqual([409, 409]);
    expect(await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } })).toMatchObject({ status: 'ACTIVE' });
  });
});

describe('across organisations', () => {
  // A gate another tenant could satisfy would be worse than none, because it
  // would look like one in the audit trail.
  it('reads only the asking organisation\'s interviews', async () => {
    const ids = await seeded();
    const assessmentId = await assessed(ids);
    await reviewed(ids, assessmentId);
    const stranger = await prisma.tenant.create({ data: { name: 'Other Org', region: 'in', policyJson: '{}' } });

    // The same assessment, asked about by somebody else's organisation: the
    // answer is "nothing here", never a leak of what it found.
    const seenByStranger = await assessmentReviewRequirement({ tenantId: stranger.id, assessmentId });
    expect(seenByStranger).toEqual({ required: false, because: 'no_assessment' });

    // And the candidate's own organisation still sees the review it recorded.
    const seenByOwner = await assessmentReviewRequirement({ tenantId: ids.tenantId, assessmentId });
    expect(seenByOwner).toMatchObject({ required: true, satisfied: true });
  });

  it('does not let a stranger\'s tenant id find the candidate\'s interviews', async () => {
    const ids = await seeded();
    await assessed(ids);
    const stranger = await prisma.tenant.create({ data: { name: 'Other Org 2', region: 'in', policyJson: '{}' } });
    const check = await humanReviewCheck({ tenantId: stranger.id, candidateId: ids.candidateId, roleId: ids.roleId });
    expect(check).toEqual({ missing: null, record: { required: false, because: 'no_ai_interview' } });
  });
});
