import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * Booking a human round reaches the person who will conduct it.
 *
 * The only email a booking sent went to whoever pressed the button. An expert
 * seated on a Gold round was never told by Questor at all — they found out
 * because a colleague messaged them, or they did not find out. Moving or
 * cancelling the round was worse: an interviewer holding a time that is no
 * longer the time is worse off than one who was never told.
 */

const mail = vi.hoisted(() => ({ delivers: true, messages: [] as Array<{ to: string; subject: string; text: string; html: string }> }));

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: mail.delivers,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        mail.messages.push(msg);
        return { status: 'sent', id: `test-${mail.messages.length}` };
      },
    }),
  };
});

const app = createApp();

interface Seeded {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly auth: string;
}

async function seeded(): Promise<Seeded> {
  await wipe();
  mail.delivers = true;
  mail.messages.length = 0;
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { tenantId: ids.tenantId, candidateId: ids.candidateId, auth: `Bearer ${login.body.token as string}` };
}

async function colleague(tenantId: string, handle: string, role: 'recruiter' | 'sme') {
  const user = await prisma.user.create({
    data: { tenantId, email: `${handle}@demo.local`, name: handle, passwordHash: 'x', role },
  });
  return { id: user.id, email: user.email, auth: `Bearer ${signToken({ userId: user.id, tenantId, role, email: user.email })}` };
}

async function pipelineAtGold(auth: string, candidateId: string) {
  const created = await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId });
  const id = created.body.pipeline.id as string;
  for (const toStageKey of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', auth).send({ toStageKey });
  }
  return id;
}

const SOON = new Date(Date.now() + 5 * 86_400_000).toISOString();

function book(auth: string, pipelineId: string, body: Record<string, unknown>) {
  return request(app).post(`/api/pipelines/${pipelineId}/rounds`).set('Authorization', auth).send(body);
}

const to = (address: string) => mail.messages.filter((m) => m.to === address);

describe('telling the interviewer a round was booked', () => {
  beforeEach(async () => { await wipe(); });

  it('emails the colleague seated on the round, not only the person who booked it', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'seated-one', 'recruiter');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(to(seat.email)).toHaveLength(1);
  });

  it('writes the interviewer that they are conducting it, not that their booking is confirmed', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'seated-two', 'recruiter');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(to(seat.email)[0].text).toContain('conduct');
  });

  it('reports each interviewer notice separately so one address is not spoken for by another', async () => {
    const ids = await seeded();
    const lead = await colleague(ids.tenantId, 'seated-lead', 'recruiter');
    const panel = await colleague(ids.tenantId, 'seated-panel', 'recruiter');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    const res = await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [lead.id, panel.id] });

    expect(res.body.interviewerNotices.map((n: { userId: string }) => n.userId)).toEqual([lead.id, panel.id]);
  });

  it('says plainly that nothing was delivered when the provider delivers nothing', async () => {
    const ids = await seeded();
    mail.delivers = false;
    const seat = await colleague(ids.tenantId, 'seated-undelivered', 'recruiter');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    const res = await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(res.body.interviewerNotices[0]).toMatchObject({ delivered: false });
  });

  it('leaves the booker their own confirmation untouched when they are not in the room', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'seated-three', 'recruiter');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    const res = await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(res.body.notification.link).toContain(`/candidates/${ids.candidateId}`);
  });

  // One click, one letter. A booker who seated themselves gets the
  // interviewer's letter, which is the one they will go looking for on the day.
  it('does not send the booker two letters when they seated themselves', async () => {
    const ids = await seeded();
    const me = await prisma.user.findFirstOrThrow({ where: { tenantId: ids.tenantId, role: 'admin' }, select: { id: true, email: true } });
    const login = { auth: `Bearer ${signToken({ userId: me.id, tenantId: ids.tenantId, role: 'admin', email: me.email })}` };
    const pipelineId = await pipelineAtGold(login.auth, ids.candidateId);

    await book(login.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [me.id] });

    expect(to(me.email)).toHaveLength(1);
  });

  it('never emails a seat whose account no longer exists', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'seated-gone', 'recruiter');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);
    const res = await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });
    mail.messages.length = 0;
    await prisma.roundInterviewer.deleteMany({ where: { userId: seat.id } });
    await prisma.candidateAssignment.deleteMany({ where: { userId: seat.id } });
    await prisma.user.delete({ where: { id: seat.id } });

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${res.body.round.id}/cancel`).set('Authorization', ids.auth).send({});

    expect(to(seat.email)).toHaveLength(0);
  });

  // HR brings an expert in after the fact to read the recording and say what
  // they think. "You are booked to interview" would be false; the ask is a read.
  it('asks for an assessment, not an attendance, when the round has already happened', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'seated-past', 'recruiter');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: new Date(Date.now() - 86_400_000).toISOString(), interviewerUserIds: [seat.id],
    });

    expect(to(seat.email)[0].subject).toMatch(/assessment/i);
  });
});

describe('the link an interviewer is given', () => {
  beforeEach(async () => { await wipe(); });

  it('sends an expert who holds the candidate to their own surface, not the HR page', async () => {
    const ids = await seeded();
    const expert = await colleague(ids.tenantId, 'seated-expert', 'sme');
    await request(app).post(`/api/candidates/${ids.candidateId}/sme`).set('Authorization', ids.auth).send({ userId: expert.id });
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [expert.id] });

    expect(to(expert.email)[0].text).toContain(`/sme/candidates/${ids.candidateId}`);
  });

  it('does not send an expert to a candidate page their assignment would refuse', async () => {
    const ids = await seeded();
    const expert = await colleague(ids.tenantId, 'seated-unassigned', 'sme');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [expert.id] });

    expect(to(expert.email)[0].text).not.toContain(`/sme/candidates/${ids.candidateId}`);
  });

  it('sends a colleague who works in candidate scope to the candidate page', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'seated-hr', 'recruiter');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(to(seat.email)[0].text).toContain(`/candidates/${ids.candidateId}`);
  });
});

describe('telling the interviewer when the round changes', () => {
  beforeEach(async () => { await wipe(); });

  async function bookedRound(ids: Seeded, handle: string) {
    const seat = await colleague(ids.tenantId, handle, 'recruiter');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);
    const res = await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });
    mail.messages.length = 0;
    return { seat, pipelineId, roundId: res.body.round.id as string };
  }

  it('tells them the round moved, so nobody is left holding the old time', async () => {
    const ids = await seeded();
    const { seat, pipelineId, roundId } = await bookedRound(ids, 'moved-seat');

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/reschedule`).set('Authorization', ids.auth)
      .send({ scheduledAt: new Date(Date.now() + 9 * 86_400_000).toISOString() });

    expect(to(seat.email)[0].subject).toContain('moved');
  });

  // The letter has to contradict the one before it by name. "It is now at 3pm"
  // reads as a confirmation to somebody who never opened the first letter.
  it('names the time the round was, as well as the time it now is', async () => {
    const ids = await seeded();
    const { seat, pipelineId, roundId } = await bookedRound(ids, 'moved-old-time');

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/reschedule`).set('Authorization', ids.auth)
      .send({ scheduledAt: new Date(Date.now() + 9 * 86_400_000).toISOString() });

    expect(to(seat.email)[0].text).toMatch(/was booked for/i);
  });

  it('tells them the round is off', async () => {
    const ids = await seeded();
    const { seat, pipelineId, roundId } = await bookedRound(ids, 'cancelled-seat');

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/cancel`).set('Authorization', ids.auth).send({});

    expect(to(seat.email)).toHaveLength(1);
  });

  it('tells them the meeting link that did not exist when the round was booked', async () => {
    const ids = await seeded();
    const { seat, pipelineId, roundId } = await bookedRound(ids, 'link-seat');

    await request(app).put(`/api/pipelines/${pipelineId}/rounds/${roundId}/meeting-link`).set('Authorization', ids.auth)
      .send({ url: 'https://meet.example.com/late-link' });

    expect(to(seat.email)[0].text).toContain('https://meet.example.com/late-link');
  });
});
