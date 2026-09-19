import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/** Shared fixtures for the AI-observer-on-human-rounds tests. */

export const SPOKEN = 'I led the rollback of our billing pipeline and wrote the postmortem myself.';

export async function seededObserver(app: Express) {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

export type Seeded = Awaited<ReturnType<typeof seededObserver>>;

/** A pipeline at Gold with one human round (AI observer) scheduled. */
export async function humanRound(app: Express, ids: Seeded) {
  const created = await request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId: ids.candidateId });
  const pipelineId = created.body.pipeline.id as string;
  for (const toStageKey of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey });
  }
  const round = await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set('Authorization', ids.auth)
    .send({ stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewers: ['Hiring manager'] });
  return { pipelineId, roundId: round.body.round.id as string };
}

/** The candidate's token, taken from the link the interviewer is shown. */
export function tokenFromLink(link: string): string {
  return link.split('/').pop() as string;
}

/** Interviewer consents; returns the candidate's consent token. */
export async function interviewerConsents(app: Express, auth: string, roundId: string): Promise<string> {
  const res = await request(app).post(`/api/observer/rounds/${roundId}/consent`).set('Authorization', auth).send({});
  return tokenFromLink(res.body.observation.candidateLink as string);
}

/** Both parties consent and the interviewer starts listening. */
export async function listening(app: Express, ids: Seeded) {
  const { pipelineId, roundId } = await humanRound(app, ids);
  const token = await interviewerConsents(app, ids.auth, roundId);
  await request(app).post(`/api/observer-consent/${token}/consent`).send({});
  await request(app).post(`/api/observer/rounds/${roundId}/start`).set('Authorization', ids.auth).send({});
  return { pipelineId, roundId, token };
}

export function sendText(app: Express, auth: string, roundId: string, text = SPOKEN, offsetMs = 0) {
  return request(app).post(`/api/observer/rounds/${roundId}/segments`).set('Authorization', auth)
    .send({ text, offsetMs, durationMs: 30_000 });
}

export async function colleagueAuth(tenantId: string, role = 'recruiter', email = 'colleague@demo.local') {
  const user = await prisma.user.create({ data: { tenantId, email, name: 'Colleague', passwordHash: 'x', role } });
  return `Bearer ${signToken({ userId: user.id, tenantId, role, email })}`;
}

export async function observationOf(roundId: string) {
  return prisma.roundObservation.findUniqueOrThrow({ where: { roundId }, include: { segments: true } });
}
