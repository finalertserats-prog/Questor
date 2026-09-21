import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * Scheduling in the zone the recruiter chose.
 *
 * The console used to send the browser's idea of the time as UTC and store no
 * zone, so the candidate's email said nothing about when, and anyone reading
 * the time later read it on their own clock. The time is now booked as a date,
 * a time and a zone; the server does the conversion, keeps the zone, and says
 * the time in that zone wherever a person reads it.
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

type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;
let bearer = '';
const auth = () => ({ Authorization: bearer });

/** A date a few days out, as the picker sends it. */
function futureDate(days = 5): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function setTenantZone(timeZone: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: demo.tenantId } });
  await prisma.tenant.update({ where: { id: demo.tenantId }, data: { policyJson: JSON.stringify({ ...JSON.parse(tenant.policyJson), timeZone }) } });
}

async function provisionedSession() {
  return prisma.interviewSession.create({
    data: { tenantId: demo.tenantId, candidateId: demo.candidateId, roleId: demo.roleId, scorecardId: demo.scorecardId, state: 'PROVISIONED' },
  });
}

beforeEach(async () => {
  await wipe();
  mail.delivers = true;
  mail.messages.length = 0;
  demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  bearer = `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email })}`;
});

describe('scheduling an interview in a chosen zone', () => {
  it('stores the instant the zone names', async () => {
    const date = futureDate();

    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth()).send({ date, time: '14:30', timeZone: 'Asia/Kolkata' });

    const saved = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect(saved.scheduledAt?.toISOString()).toBe(`${date}T09:00:00.000Z`);
  });

  it('keeps the zone it was booked in', async () => {
    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth()).send({ date: futureDate(), time: '14:30', timeZone: 'Asia/Kolkata' });

    const res = await request(app).get(`/api/interviews/${demo.sessionId}`).set(auth());

    expect(res.body.session.scheduledTimeZone).toBe('Asia/Kolkata');
  });

  it('refuses a time the clocks skip, naming the zone', async () => {
    const res = await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth())
      .send({ date: '2030-03-31', time: '01:30', timeZone: 'Europe/London' });

    expect({ status: res.status, names: String(res.body.error ?? '').includes('Europe/London') }).toEqual({ status: 400, names: true });
  });

  it('refuses a time that has already passed', async () => {
    const res = await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth())
      .send({ date: '2020-01-01', time: '09:00', timeZone: 'Asia/Kolkata' });

    expect(res.status).toBe(400);
  });

  it('refuses a zone that does not exist', async () => {
    const res = await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth())
      .send({ date: futureDate(), time: '09:00', timeZone: 'Asia/Nowhere' });

    expect(res.status).toBe(400);
  });

  it('refuses a round booked in year 99 rather than storing 1999', async () => {
    const pipelineId = (await request(app).post('/api/pipelines').set(auth()).send({ candidateId: demo.candidateId })).body.pipeline.id as string;
    for (const key of ['bronze', 'silver', 'gold']) {
      await request(app).post(`/api/pipelines/${pipelineId}/advance`).set(auth()).send({ toStageKey: key });
    }

    const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth())
      .send({ stageKey: 'gold', date: '0099-01-01', time: '09:00', timeZone: 'UTC' });

    expect(res.status).toBe(400);
  });

  it('refuses a date without a time', async () => {
    const res = await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth())
      .send({ date: futureDate(), timeZone: 'Asia/Kolkata' });

    expect(res.status).toBe(400);
  });

  it('still takes the older offset form, with no zone recorded', async () => {
    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth())
      .send({ scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });

    const saved = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect(saved.scheduledTimeZone).toBeNull();
  });

  it('clears an earlier zone when the older form moves the time', async () => {
    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth()).send({ date: futureDate(), time: '14:30', timeZone: 'Asia/Kolkata' });

    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth())
      .send({ scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });

    const saved = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect(saved.scheduledTimeZone).toBeNull();
  });

  it('refuses a past time in the older form too', async () => {
    const res = await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth())
      .send({ scheduledAt: '2020-01-01T09:00:00Z' });

    expect(res.status).toBe(400);
  });
});

describe('saving a schedule and sending in one step', () => {
  it('invites a candidate who has not been invited yet', async () => {
    const session = await provisionedSession();

    await request(app).post(`/api/interviews/${session.id}/schedule`).set(auth()).send({ date: futureDate(), time: '14:30', timeZone: 'Asia/Kolkata', send: true });

    const saved = await prisma.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(saved.state).toBe('INVITED');
  });

  it('puts the time, in the chosen zone, into the invitation', async () => {
    const session = await provisionedSession();

    await request(app).post(`/api/interviews/${session.id}/schedule`).set(auth()).send({ date: futureDate(), time: '14:30', timeZone: 'Asia/Kolkata', send: true });

    expect(mail.messages.at(-1)?.text ?? '').toMatch(/14:30.*Asia\/Kolkata.*09:00 UTC/);
  });

  it('resends to a candidate already invited, with the new time', async () => {
    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth()).send({ date: futureDate(), time: '16:15', timeZone: 'Europe/Berlin', send: true });

    expect(mail.messages.at(-1)?.text ?? '').toContain('16:15');
  });

  it('reports the send in the response', async () => {
    const res = await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth()).send({ date: futureDate(), time: '16:15', timeZone: 'Europe/Berlin', send: true });

    expect(res.body.delivery).toMatchObject({ sent: true });
  });

  it('keeps the schedule when the email cannot be sent, and says so', async () => {
    mail.delivers = false;

    const res = await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth()).send({ date: futureDate(), time: '16:15', timeZone: 'Europe/Berlin', send: true });

    expect({ status: res.status, sent: res.body.delivery?.sent }).toEqual({ status: 200, sent: false });
  });

  it('sends nothing when only asked to save', async () => {
    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth()).send({ date: futureDate(), time: '16:15', timeZone: 'Europe/Berlin' });

    expect(mail.messages).toHaveLength(0);
  });
});

describe('a resend after the time moved', () => {
  it('carries the new time', async () => {
    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth()).send({ date: futureDate(), time: '11:45', timeZone: 'America/New_York' });

    await request(app).post(`/api/interviews/${demo.sessionId}/resend`).set(auth()).send({});

    expect(mail.messages.at(-1)?.text ?? '').toContain('11:45');
  });

  it('says nothing about a time when none was set', async () => {
    await request(app).post(`/api/interviews/${demo.sessionId}/resend`).set(auth()).send({});

    expect(mail.messages.at(-1)?.text ?? '').not.toContain('booked for');
  });
});

describe('the candidate portal', () => {
  it('shows the booked time in the zone it was booked in', async () => {
    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth()).send({ date: futureDate(), time: '14:30', timeZone: 'Asia/Kolkata' });

    const res = await request(app).get(`/api/portal/${demo.token}`);

    expect(res.body.schedule?.text ?? '').toMatch(/14:30.*Asia\/Kolkata/);
  });

  it('falls back to the organisation zone for a time booked without one', async () => {
    await setTenantZone('Asia/Kolkata');
    await prisma.interviewSession.update({ where: { id: demo.sessionId }, data: { scheduledAt: new Date(Date.now() + 86_400_000) } });

    const res = await request(app).get(`/api/portal/${demo.token}`);

    expect(res.body.schedule?.timeZone).toBe('Asia/Kolkata');
  });

  it('drops the booking once the interview has started', async () => {
    await prisma.interviewSession.update({ where: { id: demo.sessionId }, data: { scheduledAt: new Date(Date.now() + 86_400_000), startedAt: new Date() } });

    const res = await request(app).get(`/api/portal/${demo.token}`);

    expect(res.body.schedule).toBeNull();
  });

  it('has no schedule when none was set', async () => {
    const res = await request(app).get(`/api/portal/${demo.token}`);

    expect(res.body.schedule).toBeNull();
  });
});

describe('the organisation time zone', () => {
  it('is readable by someone who schedules', async () => {
    await setTenantZone('Asia/Kolkata');

    const res = await request(app).get('/api/interviews/time-zone').set(auth());

    expect(res.body.timeZone).toBe('Asia/Kolkata');
  });

  it('is null when the organisation has not set one', async () => {
    const res = await request(app).get('/api/interviews/time-zone').set(auth());

    expect(res.body.timeZone).toBeNull();
  });
});

describe('interview rounds', () => {
  async function goldPipeline(): Promise<string> {
    const pipelineId = (await request(app).post('/api/pipelines').set(auth()).send({ candidateId: demo.candidateId })).body.pipeline.id as string;
    for (const key of ['bronze', 'silver', 'gold']) {
      await request(app).post(`/api/pipelines/${pipelineId}/advance`).set(auth()).send({ toStageKey: key });
    }
    return pipelineId;
  }

  it('keep the zone a round was booked in', async () => {
    const pipelineId = await goldPipeline();

    const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth())
      .send({ stageKey: 'gold', date: futureDate(), time: '10:00', timeZone: 'America/New_York' });

    expect(res.body.round?.scheduledTimeZone).toBe('America/New_York');
  });

  it('email the scheduler in the round zone rather than the organisation zone', async () => {
    await setTenantZone('Asia/Kolkata');
    const pipelineId = await goldPipeline();

    await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth())
      .send({ stageKey: 'gold', date: futureDate(), time: '10:00', timeZone: 'America/New_York' });

    expect(mail.messages.at(-1)?.text ?? '').toContain('America/New_York');
  });

  it('move to a new time in a new zone', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth())
      .send({ stageKey: 'gold', date: futureDate(), time: '10:00', timeZone: 'America/New_York' })).body.round.id as string;

    const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/reschedule`).set(auth())
      .send({ date: futureDate(6), time: '15:00', timeZone: 'Europe/London' });

    expect(res.body.round?.scheduledTimeZone).toBe('Europe/London');
  });

  it('refuse a skipped time on reschedule', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth())
      .send({ stageKey: 'gold', date: futureDate(), time: '10:00', timeZone: 'America/New_York' })).body.round.id as string;

    const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/reschedule`).set(auth())
      .send({ date: '2030-03-10', time: '02:30', timeZone: 'America/New_York' });

    expect(res.status).toBe(400);
  });
});
