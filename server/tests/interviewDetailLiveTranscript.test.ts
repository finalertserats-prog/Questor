import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * The interview page must not become a way round the observer-consent gate.
 * /observe and /transcript refuse turns while the candidate may still be on
 * the call unless they were told someone may watch; GET /api/interviews/:id
 * returned every turn in any state, so polling it was live observation.
 */

const app = createApp();

async function interviewWithTurns(state: string) {
  const ids = await createDemoData();
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state } });
  await prisma.turn.createMany({
    data: [
      { sessionId: ids.sessionId, index: 0, speaker: 'agent', text: 'Tell me about a recent project.', startMs: 0, endMs: 1000 },
      { sessionId: ids.sessionId, index: 1, speaker: 'candidate', text: 'I rebuilt our billing pipeline.', startMs: 1000, endMs: 2000 },
    ],
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  return { ...ids, auth };
}

beforeEach(async () => { await wipe(); });

describe('the interview page while the candidate may be on the call', () => {
  it('leaves the turns out when the candidate was not told someone may observe', async () => {
    const ids = await interviewWithTurns('WARMUP');
    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set(ids.auth);
    expect(res.body.turns).toEqual([]);
  });

  it('says why the turns are missing', async () => {
    const ids = await interviewWithTurns('WARMUP');
    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set(ids.auth);
    expect(res.body.transcriptWithheld).toBe(true);
  });
});

describe('the interview page once the interview has ended', () => {
  it('returns the turns', async () => {
    const ids = await interviewWithTurns('REVIEW_READY');
    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set(ids.auth);
    expect(res.body.turns).toHaveLength(2);
  });

  it('does not mark the transcript as withheld', async () => {
    const ids = await interviewWithTurns('REVIEW_READY');
    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set(ids.auth);
    expect(res.body.transcriptWithheld).toBeUndefined();
  });
});
