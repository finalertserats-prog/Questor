import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { TRANSCRIPT_NOT_READ } from '../src/domain/transcriptRead.js';
import { readTranscript, readTranscriptElsewhere, READ_ELSEWHERE } from './reviewGateHelpers.js';
import { eraseCandidate } from '../src/services/dataRights.js';

/**
 * "Read the transcript before recording your review."
 *
 * The page has said this for as long as there has been a review page, and said
 * honestly that it was only asking. Here it is a rule: the server refuses a
 * verdict on the AI round from a reviewer with no record of having read the
 * conversation.
 *
 * The definition is turns, not scroll distance. That is what makes the gate
 * satisfiable by someone reading with a keyboard or a screen reader — neither
 * of whom moves a scrollbar — and what lets the server check the claim against
 * the interview that exists rather than taking the page's word for it.
 */

const app = createApp();
const REASON = 'The evidence on the core competencies was clear and consistent.';
const RESULT = {
  recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, overallScore: 70,
  competencies: [], strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
};

async function assessedInterview() {
  const ids = await createDemoData();
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY' } });
  await prisma.turn.createMany({
    data: [
      { sessionId: ids.sessionId, index: 0, speaker: 'agent', text: 'Tell me about an incident you owned.' },
      { sessionId: ids.sessionId, index: 1, speaker: 'candidate', text: 'I led the rollback.' },
      { sessionId: ids.sessionId, index: 2, speaker: 'agent', text: 'What changed afterwards?' },
      { sessionId: ids.sessionId, index: 3, speaker: 'candidate', text: 'Unmatched rows fell by two orders of magnitude.' },
    ],
  });
  const assessment = await prisma.assessmentVersion.create({
    data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, resultJson: JSON.stringify(RESULT) },
  });
  const auth = `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}`;
  return { ...ids, assessmentId: assessment.id, auth };
}

type Fixture = Awaited<ReturnType<typeof assessedInterview>>;

function submitVerdict(ids: Fixture, body: Record<string, unknown> = {}) {
  return request(app).post(`/api/assessments/${ids.assessmentId}/review`).set('Authorization', ids.auth)
    .send({ verdict: 'PROCEED', reason: REASON, applyToJourney: false, ...body });
}

function reportRead(ids: Fixture, body: Record<string, unknown>) {
  return request(app).post(`/api/assessments/${ids.assessmentId}/transcript-read`).set('Authorization', ids.auth).send(body);
}

beforeEach(async () => { await wipe(); });

describe('a verdict from a reviewer who has not read the transcript', () => {
  it('is refused', async () => {
    const ids = await assessedInterview();
    expect((await submitVerdict(ids)).status).toBe(409);
  });

  it('carries a code the page can act on, so it can offer the transcript', async () => {
    const ids = await assessedInterview();
    expect((await submitVerdict(ids)).body.code).toBe(TRANSCRIPT_NOT_READ);
  });

  it('names both ways out rather than leaving a dead end', async () => {
    const ids = await assessedInterview();
    expect((await submitVerdict(ids)).body.error).toContain('read it elsewhere');
  });

  it('writes no review', async () => {
    const ids = await assessedInterview();
    await submitVerdict(ids);
    expect(await prisma.humanReview.count()).toBe(0);
  });

  // A gate that lives only in the browser is not a gate: the whole point is
  // that a request bypassing the page gets the same answer.
  it('is refused even when the request never went near the page', async () => {
    const ids = await assessedInterview();
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/review`).set('Authorization', ids.auth)
      .send({ verdict: 'DO_NOT_PROGRESS', reason: REASON });
    expect(res.status).toBe(409);
  });
});

describe('reading it in the app', () => {
  it('needs every turn of the conversation, not most of them', async () => {
    const ids = await assessedInterview();
    expect((await reportRead(ids, { method: 'in_app', seenIndexes: [0, 1, 2] })).status).toBe(400);
  });

  it('says how much is left', async () => {
    const ids = await assessedInterview();
    const res = await reportRead(ids, { method: 'in_app', seenIndexes: [0] });
    expect(res.body.error).toContain('4 turns and 1 of them have been shown');
  });

  it('is satisfied by a report covering the whole transcript', async () => {
    const ids = await assessedInterview();
    expect((await reportRead(ids, { method: 'in_app', seenIndexes: [0, 1, 2, 3] })).status).toBe(201);
  });

  it('lets the verdict through afterwards', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    expect((await submitVerdict(ids)).status).toBe(201);
  });

  it('does not accept a claim from a client that never loaded the transcript', async () => {
    const ids = await assessedInterview();
    expect((await reportRead(ids, { method: 'in_app', seenIndexes: [] })).status).toBe(400);
  });

  // The order is real, not a range: a client that guesses cannot cover turns
  // it never fetched.
  it('does not accept turns the interview does not have', async () => {
    const ids = await assessedInterview();
    expect((await reportRead(ids, { method: 'in_app', seenIndexes: [9, 10, 11, 12] })).status).toBe(400);
  });

  it('records how much was read', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    const stored = await prisma.transcriptRead.findFirstOrThrow({ where: { assessmentId: ids.assessmentId } });
    expect(stored).toMatchObject({ method: 'in_app', turnsSeen: 4, turnsTotal: 4 });
  });

  // A reviewer who reads it twice has read it; a double-click is not a second
  // opinion, and the unique key is what decides that rather than a read.
  it('lands once however many times it is sent', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    await readTranscript(app, ids.assessmentId, ids.auth);
    expect(await prisma.transcriptRead.count({ where: { assessmentId: ids.assessmentId } })).toBe(1);
  });
});

describe('reading it elsewhere', () => {
  it('is accepted with a sentence saying where', async () => {
    const ids = await assessedInterview();
    expect((await readTranscriptElsewhere(app, ids.assessmentId, ids.auth)).status).toBe(201);
  });

  it('lets the verdict through', async () => {
    const ids = await assessedInterview();
    await readTranscriptElsewhere(app, ids.assessmentId, ids.auth);
    expect((await submitVerdict(ids)).status).toBe(201);
  });

  it('does not need a single turn to have been shown in the app', async () => {
    const ids = await assessedInterview();
    const res = await reportRead(ids, { method: 'elsewhere', attestation: READ_ELSEWHERE });
    expect(res.body.transcriptRead).toMatchObject({ method: 'elsewhere', turnsSeen: 0, turnsTotal: 4 });
  });

  it('refuses a reviewer who will not say where', async () => {
    const ids = await assessedInterview();
    expect((await reportRead(ids, { method: 'elsewhere', attestation: 'read it' })).status).toBe(400);
  });

  // The record is the whole value of this path. If it were not kept, the path
  // would just be a button that turns the gate off.
  it('keeps what they said, with their name against it', async () => {
    const ids = await assessedInterview();
    await readTranscriptElsewhere(app, ids.assessmentId, ids.auth);
    const stored = await prisma.transcriptRead.findFirstOrThrow({ where: { assessmentId: ids.assessmentId } });
    expect(stored).toMatchObject({ method: 'elsewhere', attestation: READ_ELSEWHERE, reviewerId: ids.userId });
  });

  it('audits it as its own event', async () => {
    const ids = await assessedInterview();
    await readTranscriptElsewhere(app, ids.assessmentId, ids.auth);
    const [event] = await prisma.auditEvent.findMany({ where: { action: 'review.transcript_read', entityId: ids.assessmentId } });
    expect(JSON.parse(event.afterJson) as Record<string, unknown>).toMatchObject({ method: 'elsewhere', turnsTotal: 4 });
    expect(event.actorId).toBe(ids.userId);
  });

  // The sentence itself is the candidate's record, erased with them; the trail
  // keeps that one was given, as it does for consent and decisions.
  it('keeps the attestation text out of the audit trail', async () => {
    const ids = await assessedInterview();
    await readTranscriptElsewhere(app, ids.assessmentId, ids.auth);
    const [event] = await prisma.auditEvent.findMany({ where: { action: 'review.transcript_read' } });
    expect(event.afterJson).not.toContain('downloaded transcript');
    expect(JSON.parse(event.afterJson) as { attestationChars: number }).toMatchObject({ attestationChars: READ_ELSEWHERE.length });
  });
});

describe('what the record says on the verdict', () => {
  it('names how the requirement was met', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    await submitVerdict(ids);
    const [event] = await prisma.auditEvent.findMany({ where: { action: 'review.completed', entityId: ids.assessmentId } });
    expect((JSON.parse(event.afterJson) as { transcriptRead: Record<string, unknown> }).transcriptRead)
      .toMatchObject({ method: 'in_app', turnsSeen: 4, turnsTotal: 4 });
  });

  it('distinguishes a reviewer who read it elsewhere', async () => {
    const ids = await assessedInterview();
    await readTranscriptElsewhere(app, ids.assessmentId, ids.auth);
    await submitVerdict(ids);
    const [event] = await prisma.auditEvent.findMany({ where: { action: 'review.completed', entityId: ids.assessmentId } });
    expect((JSON.parse(event.afterJson) as { transcriptRead: { method: string } }).transcriptRead.method).toBe('elsewhere');
  });
});

describe('one reader does not discharge another\'s duty', () => {
  it('still refuses a second reviewer who has not read it', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    const colleague = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: 'second.reviewer@questor.local', name: 'Second Reviewer', passwordHash: 'x', role: 'admin' },
    });
    const theirAuth = `Bearer ${signToken({ userId: colleague.id, tenantId: ids.tenantId, role: 'admin', email: colleague.email })}`;
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/review`).set('Authorization', theirAuth)
      .send({ verdict: 'PROCEED', reason: REASON, applyToJourney: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(TRANSCRIPT_NOT_READ);
  });
});

describe('the rest of the verdict flow', () => {
  it('still records level overrides', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    const res = await submitVerdict(ids, {
      overrides: [{ competencyId: 'own', from: 2, to: 4, reason: 'The rollback answer carries this one.' }],
    });
    expect(res.status).toBe(201);
    const review = await prisma.humanReview.findFirstOrThrow({ where: { assessmentId: ids.assessmentId } });
    expect(JSON.parse(review.overridesJson) as unknown[]).toHaveLength(1);
  });

  it('still replays a submit that arrives twice rather than refusing it', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    const submissionId = 'submit-abcdefgh';
    const first = await submitVerdict(ids, { submissionId });
    const second = await submitVerdict(ids, { submissionId });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
  });

  it('still refuses a second, different review without a reason to supersede', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    await submitVerdict(ids);
    const res = await submitVerdict(ids, { verdict: 'DO_NOT_PROGRESS' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already been reviewed');
  });

  // A blind verdict is recorded before the AI's reading is revealed and is not
  // the completed review. It stays open so the blind flow still works; the
  // verdict that records the outcome is the one this gate holds.
  it('leaves the blind verdict reachable', async () => {
    const ids = await assessedInterview();
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/blind-verdict`).set('Authorization', ids.auth)
      .send({ verdict: 'PROCEED', reason: REASON, competencyLevels: {} });
    expect(res.status).not.toBe(409);
  });
});

describe('what the page can ask', () => {
  it('reports nothing before the reviewer has read it', async () => {
    const ids = await assessedInterview();
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/transcript-read`).set('Authorization', ids.auth);
    expect(res.body.transcriptRead).toBeNull();
  });

  it('reports the record once they have', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/transcript-read`).set('Authorization', ids.auth);
    expect(res.body.transcriptRead).toMatchObject({ method: 'in_app', turnsSeen: 4, turnsTotal: 4 });
  });

  it('does not report another organisation\'s reading', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    const stranger = await prisma.tenant.create({ data: { name: 'Other Org', region: 'in', policyJson: '{}' } });
    const user = await prisma.user.create({
      data: { tenantId: stranger.id, email: 'nosy@other.local', name: 'Nosy', passwordHash: 'x', role: 'admin' },
    });
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/transcript-read`)
      .set('Authorization', `Bearer ${signToken({ userId: user.id, tenantId: stranger.id, role: 'admin', email: user.email })}`);
    expect(res.status).toBe(404);
  });
});

describe('erasing the candidate', () => {
  // The row names the candidate's interview and holds a required key onto the
  // assessment. Prisma's foreign keys RESTRICT rather than cascade here, as
  // every other relation in this schema does, so an erasure that did not
  // delete it first would fail on a constraint — and an erasure that fails is
  // a legal obligation that did not happen. This is the test that says it does.
  it('takes the reading record with it, rather than failing on a constraint', async () => {
    const ids = await assessedInterview();
    await readTranscriptElsewhere(app, ids.assessmentId, ids.auth);
    expect(await prisma.transcriptRead.count()).toBe(1);

    await eraseCandidate({ tenantId: ids.tenantId, candidateId: ids.candidateId, actorId: ids.userId, reason: 'Asked to be forgotten.' });

    expect(await prisma.transcriptRead.count()).toBe(0);
    expect(await prisma.assessmentVersion.count()).toBe(0);
  });

  // The sentence the reviewer wrote is the candidate's record and goes with
  // them; that a reading happened is a compliance fact and survives, as consent
  // and decision events do.
  it('leaves the audit trail saying that the transcript was read', async () => {
    const ids = await assessedInterview();
    await readTranscriptElsewhere(app, ids.assessmentId, ids.auth);

    await eraseCandidate({ tenantId: ids.tenantId, candidateId: ids.candidateId, actorId: ids.userId, reason: 'Asked to be forgotten.' });

    expect(await prisma.auditEvent.count({ where: { action: 'review.transcript_read' } })).toBe(1);
  });

  it('erases it even when the reviewer read it in the app', async () => {
    const ids = await assessedInterview();
    await readTranscript(app, ids.assessmentId, ids.auth);
    await eraseCandidate({ tenantId: ids.tenantId, candidateId: ids.candidateId, actorId: ids.userId, reason: 'Asked to be forgotten.' });
    expect(await prisma.transcriptRead.count()).toBe(0);
  });
});
