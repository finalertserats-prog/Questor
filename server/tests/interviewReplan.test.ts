import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData, type DemoIds } from '../src/seed/demoData.js';
import { needsReplan, replanFromLatestScorecard } from '../src/services/interviewReplan.js';
import { startOrResumeInterview } from '../src/realtime/interviewEngine.js';
import type { RoleSuccessProfile } from '../src/domain/types.js';

/**
 * An interview that has not started follows the scorecard approved most
 * recently; one that has been answered keeps the plan it was asked from.
 */

const app = createApp();
let ids: DemoIds;

/** A newer approved scorecard for the demo role, with the first competency dropped. */
async function approveNewScorecard(): Promise<string> {
  const current = await prisma.roleScorecardVersion.findUniqueOrThrow({ where: { id: ids.scorecardId } });
  const profile = JSON.parse(current.profileJson) as RoleSuccessProfile;
  const [dropped, ...kept] = profile.competencies;
  const total = kept.reduce((s, c) => s + c.weight, 0) || 1;
  const next: RoleSuccessProfile = {
    ...profile,
    competencies: kept.map((c) => ({ ...c, weight: Math.round((c.weight / total) * 1000) / 1000 })),
    scoringRules: { ...profile.scoringRules, mustPassCompetencyIds: profile.scoringRules.mustPassCompetencyIds.filter((id) => id !== dropped.id) },
  };
  const created = await prisma.roleScorecardVersion.create({
    data: { roleId: ids.roleId, version: current.version + 1, status: 'approved', approvedAt: new Date(), profileJson: JSON.stringify(next) },
  });
  return created.id;
}

const planOf = () => prisma.interviewPlanVersion.findUniqueOrThrow({ where: { sessionId: ids.sessionId } });
const sessionOf = () => prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
const replanEvents = () => prisma.auditEvent.count({ where: { entityId: ids.sessionId, action: 'interview.replanned' } });

beforeEach(async () => {
  await wipe();
  ids = await createDemoData();
});

describe('needsReplan', () => {
  it('is true with no answers and a newer approved scorecard', () => {
    expect(needsReplan({ scorecardId: 'v1', candidateTurns: 0 }, 'v2')).toBe(true);
  });

  it('is false once the candidate has answered', () => {
    expect(needsReplan({ scorecardId: 'v1', candidateTurns: 1 }, 'v2')).toBe(false);
  });

  it('is false when the session already follows the latest approved scorecard', () => {
    expect(needsReplan({ scorecardId: 'v2', candidateTurns: 0 }, 'v2')).toBe(false);
  });

  it('is false when the role has no approved scorecard at all', () => {
    expect(needsReplan({ scorecardId: 'v1', candidateTurns: 0 }, null)).toBe(false);
  });
});

describe('re-planning an interview that has not started', () => {
  it('rebuilds the plan from the newer approved scorecard', async () => {
    await approveNewScorecard();

    const outcome = await replanFromLatestScorecard(ids.sessionId);

    expect(outcome).toEqual({ replanned: true, reason: 'replanned' });
  });

  it('bumps the plan version rather than leaving a second plan row', async () => {
    await approveNewScorecard();
    await replanFromLatestScorecard(ids.sessionId);

    expect((await planOf()).version).toBe(2);
  });

  it('points the session at the new scorecard so grading uses it', async () => {
    const newId = await approveNewScorecard();
    await replanFromLatestScorecard(ids.sessionId);

    expect((await sessionOf()).scorecardId).toBe(newId);
  });

  it('leaves the dropped competency out of the rebuilt plan', async () => {
    const before = JSON.parse((await planOf()).planJson) as { blocks: Array<{ competencyId: string }> };
    const dropped = before.blocks.find((b) => !b.competencyId.startsWith('__'))!.competencyId;
    await approveNewScorecard();
    await replanFromLatestScorecard(ids.sessionId);
    const after = JSON.parse((await planOf()).planJson) as { blocks: Array<{ competencyId: string }> };

    expect(after.blocks.map((b) => b.competencyId)).not.toContain(dropped);
  });

  it('records the old and new scorecard ids in an audit event by the system', async () => {
    const newId = await approveNewScorecard();
    await replanFromLatestScorecard(ids.sessionId);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: ids.sessionId, action: 'interview.replanned' } });

    expect([event.actorType, event.beforeJson.includes(ids.scorecardId), event.afterJson.includes(newId)]).toEqual(['system', true, true]);
  });

  it('does nothing when the session already follows the latest approved scorecard', async () => {
    const outcome = await replanFromLatestScorecard(ids.sessionId);

    expect(outcome).toEqual({ replanned: false, reason: 'same_scorecard' });
  });

  it('does nothing a second time', async () => {
    await approveNewScorecard();
    await replanFromLatestScorecard(ids.sessionId);
    await replanFromLatestScorecard(ids.sessionId);

    expect([(await planOf()).version, await replanEvents()]).toEqual([2, 1]);
  });

  it('keeps the plan once the candidate has answered anything', async () => {
    await prisma.turn.create({ data: { sessionId: ids.sessionId, index: 0, speaker: 'candidate', text: 'An answer', competencyId: '' } });
    await approveNewScorecard();

    const outcome = await replanFromLatestScorecard(ids.sessionId);

    expect(outcome).toEqual({ replanned: false, reason: 'has_answers' });
  });

  it('keeps the scorecard pointer as well once answered', async () => {
    await prisma.turn.create({ data: { sessionId: ids.sessionId, index: 0, speaker: 'candidate', text: 'An answer', competencyId: '' } });
    await approveNewScorecard();
    await replanFromLatestScorecard(ids.sessionId);

    expect((await sessionOf()).scorecardId).toBe(ids.scorecardId);
  });
});

describe('re-planning at start', () => {
  async function consent() {
    await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  }

  it('re-plans when the interview starts', async () => {
    await approveNewScorecard();
    await consent();

    await startOrResumeInterview(ids.sessionId);

    expect((await planOf()).version).toBe(2);
  });

  it('writes one plan and one audit event when two starts race', async () => {
    await approveNewScorecard();
    await consent();

    await Promise.all([startOrResumeInterview(ids.sessionId), startOrResumeInterview(ids.sessionId)]);

    expect([(await planOf()).version, await replanEvents()]).toEqual([2, 1]);
  });

  it('does not re-plan a session whose scorecard is still the latest', async () => {
    await consent();

    await startOrResumeInterview(ids.sessionId);

    expect([(await planOf()).version, await replanEvents()]).toEqual([1, 0]);
  });

  it('tells the HR detail page beforehand that the plan will be rebuilt', async () => {
    await approveNewScorecard();
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set({ Authorization: `Bearer ${login.body.token}` });

    expect(res.body.replanPending).toBe(true);
  });
});
