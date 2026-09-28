import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { ENTRY_CONSEQUENCE, ENTRY_NOTICE } from '../src/domain/observedRound.js';
import { SILENT_OBSERVER_NOTICE } from '../src/services/roundInterviewerNotice.js';

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
  readonly sessionId: string;
  readonly auth: string;
}

async function seeded(): Promise<Seeded> {
  await wipe();
  mail.delivers = true;
  mail.messages.length = 0;
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { tenantId: ids.tenantId, candidateId: ids.candidateId, sessionId: ids.sessionId, auth: `Bearer ${login.body.token as string}` };
}

async function colleague(tenantId: string, handle: string, role: 'recruiter' | 'sme') {
  const user = await prisma.user.create({
    data: { tenantId, email: `${handle}@demo.local`, name: handle, passwordHash: 'x', role },
  });
  return { id: user.id, email: user.email, auth: `Bearer ${signToken({ userId: user.id, tenantId, role, email: user.email })}` };
}

async function pipelineAtStage(auth: string, candidateId: string, stop: 'silver' | 'gold') {
  const created = await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId });
  const id = created.body.pipeline.id as string;
  for (const toStageKey of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', auth).send({ toStageKey });
    if (toStageKey === stop) break;
  }
  return id;
}

const pipelineAtGold = (auth: string, candidateId: string) => pipelineAtStage(auth, candidateId, 'gold');

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

/**
 * A seat is an invitation into a room, and the two rooms are not the same one.
 *
 * On a Gold round the colleague conducts and Questor's observer transcribes —
 * so they are a recorded party, and they are told in the same words the
 * candidate is told, at booking rather than at the door. On an AI round they
 * observe and the AI conducts. Asserted through the route rather than on the
 * builder, because the builder was already right the whole time the round's
 * `aiObserver` column was never being read.
 */
describe('what a seat is told about the room it opens', () => {
  beforeEach(async () => { await wipe(); });

  it('gives a Gold interviewer the recording notice the candidate agrees to', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'gold-lead', 'sme');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(to(seat.email)[0].text).toContain(ENTRY_NOTICE);
  });

  it('tells them what happens if they would rather not be recorded', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'gold-lead-2', 'sme');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(to(seat.email)[0].text).toContain(ENTRY_CONSEQUENCE);
  });

  // The recording runs from the device the interviewer takes the call on, so
  // the round's own page is a thing they have to open — not a nicety.
  it('gives them the round’s Questor page, not only a prep page', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'gold-lead-3', 'sme');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    const booked = await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(to(seat.email)[0].text).toContain(`/rounds/${booked.body.round.id as string}/observer`);
  });

  it('names the silent observer before they click anything', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'gold-lead-4', 'sme');
    const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);

    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(to(seat.email)[0].text).toMatch(/never speaks/);
  });

  it('sends an AI round’s observer to the live-observe page instead', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'ai-watcher', 'sme');
    const pipelineId = await pipelineAtStage(ids.auth, ids.candidateId, 'silver');

    const booked = await book(ids.auth, pipelineId, {
      stageKey: 'silver', conductedBy: 'AI', sessionId: ids.sessionId, scheduledAt: SOON, interviewerUserIds: [seat.id],
    });

    expect(to(seat.email)[0].text).toContain(`/interviews/${booked.body.round.sessionId as string}/observe`);
  });

  it('tells an AI round’s observer they observe silently', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'ai-watcher-2', 'sme');
    const pipelineId = await pipelineAtStage(ids.auth, ids.candidateId, 'silver');

    await book(ids.auth, pipelineId, { stageKey: 'silver', conductedBy: 'AI', sessionId: ids.sessionId, scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(to(seat.email)[0].text).toContain(SILENT_OBSERVER_NOTICE);
  });

  // The entry notice describes a room they are not entering. Sending it for
  // every round would make it wallpaper, which is how a real notice stops
  // being read.
  it('does not give an AI round’s observer the human-round recording notice', async () => {
    const ids = await seeded();
    const seat = await colleague(ids.tenantId, 'ai-watcher-3', 'sme');
    const pipelineId = await pipelineAtStage(ids.auth, ids.candidateId, 'silver');

    await book(ids.auth, pipelineId, { stageKey: 'silver', conductedBy: 'AI', sessionId: ids.sessionId, scheduledAt: SOON, interviewerUserIds: [seat.id] });

    expect(to(seat.email)[0].text).not.toContain(ENTRY_NOTICE);
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
