import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../src/db.js';

/**
 * Helpers for the two gates a verdict now passes through.
 *
 * Every existing spec that records a review has to satisfy the transcript
 * requirement first, and that is the point of the change rather than an
 * accident of it: the server refuses a verdict from a reviewer who has not
 * read the interview. Doing it through the real endpoint here, rather than
 * writing the row directly, keeps those specs honest — if the gate stops
 * working the suite notices.
 */

/** Tell the server this reviewer read the whole transcript in the app. */
export async function readTranscript(app: Express, assessmentId: string, auth: string): Promise<void> {
  const session = await prisma.assessmentVersion.findUniqueOrThrow({ where: { id: assessmentId }, select: { sessionId: true } });
  const turns = await prisma.turn.findMany({ where: { sessionId: session.sessionId }, select: { index: true } });
  const res = await request(app).post(`/api/assessments/${assessmentId}/transcript-read`)
    .set('Authorization', auth)
    .send({ method: 'in_app', seenIndexes: turns.map((t) => t.index) });
  if (res.status !== 201) throw new Error(`transcript-read refused (${res.status}): ${JSON.stringify(res.body)}`);
}

export const READ_ELSEWHERE = 'I read the downloaded transcript in full before recording this verdict.';

/** The other honest path: read outside the app, said in a sentence. */
export async function readTranscriptElsewhere(app: Express, assessmentId: string, auth: string, attestation = READ_ELSEWHERE) {
  return request(app).post(`/api/assessments/${assessmentId}/transcript-read`)
    .set('Authorization', auth)
    .send({ method: 'elsewhere', attestation });
}

/**
 * Record a completed human review of an assessment, reading the transcript
 * first. This is what a candidate's consent screen promises them, so it is
 * what a spec needs before a pipeline decision will be accepted.
 */
export async function reviewAssessment(
  app: Express, assessmentId: string, auth: string,
  body: Record<string, unknown> = { verdict: 'PROCEED', reason: 'The evidence was clear across the core competencies.' },
) {
  await readTranscript(app, assessmentId, auth);
  return request(app).post(`/api/assessments/${assessmentId}/review`).set('Authorization', auth).send(body);
}
