import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { finalizeInterview } from '../src/realtime/interviewEngine.js';

/**
 * Finalisation must have exactly one writer.
 *
 * The state transition validated a value read earlier and then updated by id,
 * so two finalisations arriving together — the socket and the HTTP fallback, or
 * a candidate with two tabs open — both passed the check, both saw zero
 * assessments, and both wrote one. The candidate ends up with two scored
 * versions of the same interview, each with its own report, and a reviewer has
 * no way to tell which one the decision was made against.
 */

const app = createApp();

const ANSWERS = [
  'I owned the ledger pipeline end to end and made recovery idempotent after a reconciliation incident.',
  'Unmatched rows fell from two thousand a day to under thirty over the quarter.',
];

async function interviewReadyToFinalize() {
  await wipe();
  const ids = await createDemoData();
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${ids.token}/start`).send({});
  for (const text of ANSWERS) {
    await request(app).post(`/api/portal/${ids.token}/turn`).send({ text });
  }
  return ids;
}

async function finalizeTwiceAtOnce(sessionId: string) {
  return Promise.allSettled([finalizeInterview(sessionId), finalizeInterview(sessionId)]);
}

describe('two finalisations arriving at the same moment', () => {
  it('produce exactly one assessment', async () => {
    const ids = await interviewReadyToFinalize();

    await finalizeTwiceAtOnce(ids.sessionId);

    expect(await prisma.assessmentVersion.count({ where: { sessionId: ids.sessionId } })).toBe(1);
  });

  it('produce exactly one report artifact', async () => {
    const ids = await interviewReadyToFinalize();

    await finalizeTwiceAtOnce(ids.sessionId);

    expect(await prisma.artifact.count({ where: { sessionId: ids.sessionId, kind: 'report' } })).toBe(1);
  });

  it('leave the session review-ready rather than dragged back mid-interview', async () => {
    // The loser used to re-apply its own transitions by id, which could pull a
    // session that had already reached REVIEW_READY back to CANDIDATE_QUESTIONS.
    const ids = await interviewReadyToFinalize();

    await finalizeTwiceAtOnce(ids.sessionId);

    const session = await prisma.interviewSession.findUnique({ where: { id: ids.sessionId } });
    expect(session?.state).toBe('REVIEW_READY');
  });

  it('let at least one caller through', async () => {
    const ids = await interviewReadyToFinalize();

    const settled = await finalizeTwiceAtOnce(ids.sessionId);

    expect(settled.some((r) => r.status === 'fulfilled')).toBe(true);
  });
});

describe('finalising an interview that is already finished', () => {
  it('hands back the assessment that exists instead of minting another', async () => {
    const ids = await interviewReadyToFinalize();
    const first = await finalizeInterview(ids.sessionId);

    const again = await finalizeInterview(ids.sessionId);

    expect(again.assessmentId).toBe(first.assessmentId);
  });
});
