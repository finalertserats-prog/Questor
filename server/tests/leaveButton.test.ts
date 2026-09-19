import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

const app = createApp();

// The room's Leave button used to send "I want to stop the interview." as if
// the candidate had said it, and relied on the withdrawal phrase detector to
// notice. The transcript then quoted words the candidate never said, and any
// change to the detector would have turned Leave into an ordinary answer. Leave
// is now an action the server records as one.
describe('leaving through the Leave button', () => {
  let ids: Awaited<ReturnType<typeof createDemoData>>;

  beforeEach(async () => {
    await wipe();
    ids = await createDemoData();
    await request(app).post(`/api/portal/${ids.token}/accept`).send({});
    await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
    await request(app).post(`/api/portal/${ids.token}/start`).send({});
  });

  const leave = () => request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'x', leaving: true });

  it('ends the interview as a withdrawal', async () => {
    const res = await leave();
    expect(res.body.turn.withdrawn).toBe(true);
  });

  it('withdraws the session without scoring it', async () => {
    await leave();
    const session = await prisma.interviewSession.findUnique({ where: { id: ids.sessionId } });
    expect(session?.state).toBe('CANDIDATE_WITHDREW');
  });

  it('records a neutral marker, not words put in the candidate\'s mouth', async () => {
    await leave();
    const last = await prisma.turn.findFirst({ where: { sessionId: ids.sessionId, speaker: 'candidate' }, orderBy: { index: 'desc' } });
    expect(last?.text).toBe('(Left the interview)');
  });

  it('labels the turn as the Leave button', async () => {
    await leave();
    const last = await prisma.turn.findFirst({ where: { sessionId: ids.sessionId, speaker: 'candidate' }, orderBy: { index: 'desc' } });
    expect(JSON.parse(last?.metaJson ?? '{}').source).toBe('leave_button');
  });

  it('withdraws even though the marker is not a phrase the detector knows', async () => {
    const res = await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'Tell me more about the team', leaving: true });
    expect(res.body.turn.done).toBe(true);
  });

  it('shows reviewers that the candidate chose to leave', async () => {
    await leave();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.userId } });
    const auth = `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email })}`;
    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set('Authorization', auth);
    const marked = (res.body.turns as Array<{ source?: string }>).filter((t) => t.source === 'leave_button');
    expect(marked).toHaveLength(1);
  });

  // A Leave whose response was lost (network drop, second tab) is retried by
  // the room. The candidate did leave; answering the retry with "no longer
  // accepting answers" tells them the opposite of what happened.
  describe('pressed again after it already worked', () => {
    it('succeeds', async () => {
      await leave();
      const res = await leave();
      expect(res.status).toBe(200);
    });

    it('hands back the same sign-off', async () => {
      const first = await leave();
      const res = await leave();
      expect(res.body.turn).toEqual(first.body.turn);
    });

    it('writes nothing', async () => {
      await leave();
      const before = await prisma.turn.count({ where: { sessionId: ids.sessionId } });
      await leave();
      expect(await prisma.turn.count({ where: { sessionId: ids.sessionId } })).toBe(before);
    });

    it('still refuses an ordinary answer', async () => {
      await leave();
      const res = await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'One more thing.' });
      expect(res.status).toBe(409);
    });

    it('still refuses a Leave after an interview that ended some other way', async () => {
      await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'CANDIDATE_WITHDREW' } });
      const res = await leave();
      expect(res.status).toBe(409);
    });
  });

  it('keeps an ordinary answer an ordinary answer', async () => {
    const res = await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'I build data pipelines.' });
    expect(res.body.turn.withdrawn).toBe(false);
  });
});
