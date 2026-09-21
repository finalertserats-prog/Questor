import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * Scheduling a pipeline round reaches the candidate.
 *
 * A round used to be stored on the round alone: the only email went to the
 * recruiter who booked it, and an AI round's time never reached the interview
 * session the portal and the invitation read. HR saw the round on the journey
 * and assumed it had gone out; the candidate heard nothing.
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
const CANDIDATE = 'priya.sharma@example.com';

type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;
let bearer = '';
const auth = () => ({ Authorization: bearer });

function futureDate(days = 5): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const toCandidate = () => mail.messages.filter((m) => m.to === CANDIDATE);

async function pipelineAt(stage: 'silver' | 'gold'): Promise<string> {
  const pipelineId = (await request(app).post('/api/pipelines').set(auth()).send({ candidateId: demo.candidateId })).body.pipeline.id as string;
  const path = stage === 'silver' ? ['bronze', 'silver'] : ['bronze', 'silver', 'gold'];
  for (const key of path) await request(app).post(`/api/pipelines/${pipelineId}/advance`).set(auth()).send({ toStageKey: key });
  return pipelineId;
}

const bookGold = (pipelineId: string, extra: Record<string, unknown> = {}) =>
  request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth())
    .send({ stageKey: 'gold', date: futureDate(), time: '10:00', timeZone: 'America/New_York', interviewers: ['Hiring manager'], ...extra });

const bookSilver = (pipelineId: string) =>
  request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth())
    .send({ stageKey: 'silver', sessionId: demo.sessionId, date: futureDate(), time: '14:30', timeZone: 'Asia/Kolkata' });

beforeEach(async () => {
  await wipe();
  mail.delivers = true;
  mail.messages.length = 0;
  demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  bearer = `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email })}`;
});

describe('a human round', () => {
  it('emails the candidate', async () => {
    const pipelineId = await pipelineAt('gold');
    mail.messages.length = 0;

    await bookGold(pipelineId);

    expect(toCandidate()).toHaveLength(1);
  });

  it('states the time in the zone the round was booked in', async () => {
    const pipelineId = await pipelineAt('gold');

    await bookGold(pipelineId);

    expect(toCandidate().at(-1)?.text ?? '').toMatch(/10:00.*America\/New_York/);
  });

  it('carries the meeting link', async () => {
    const pipelineId = await pipelineAt('gold');

    await bookGold(pipelineId, { meetingUrl: 'https://meet.example.com/abc' });

    expect(toCandidate().at(-1)?.text ?? '').toContain('https://meet.example.com/abc');
  });

  it('says the link will follow when the round has none yet', async () => {
    const pipelineId = await pipelineAt('gold');

    await bookGold(pipelineId);

    expect(toCandidate().at(-1)?.text ?? '').toMatch(/link .*before then/i);
  });

  it('reports the candidate notice in the response', async () => {
    const pipelineId = await pipelineAt('gold');

    const res = await bookGold(pipelineId);

    expect(res.body.candidateNotice).toMatchObject({ sent: true });
  });

  it('says so when email cannot be delivered', async () => {
    const pipelineId = await pipelineAt('gold');
    mail.delivers = false;

    const res = await bookGold(pipelineId);

    expect(res.body.candidateNotice).toMatchObject({ sent: false });
  });

  it('emails nobody about a round recorded after it happened', async () => {
    const pipelineId = await pipelineAt('gold');
    mail.messages.length = 0;

    await bookGold(pipelineId, { date: '2026-01-05' });

    expect(toCandidate()).toHaveLength(0);
  });

  it('emails the candidate the new time when the round moves', async () => {
    const pipelineId = await pipelineAt('gold');
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.messages.length = 0;

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/reschedule`).set(auth())
      .send({ date: futureDate(6), time: '15:00', timeZone: 'Europe/London' });

    expect(toCandidate().at(-1)?.text ?? '').toMatch(/15:00.*Europe\/London/);
  });

  it('emails the candidate the meeting link once it is added', async () => {
    const pipelineId = await pipelineAt('gold');
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.messages.length = 0;

    await request(app).put(`/api/pipelines/${pipelineId}/rounds/${roundId}/meeting-link`).set(auth())
      .send({ url: 'https://meet.example.com/later' });

    expect(toCandidate().at(-1)?.text ?? '').toContain('https://meet.example.com/later');
  });
});

describe('the AI round', () => {
  it('moves the interview to the round time', async () => {
    const pipelineId = await pipelineAt('silver');
    const round = (await bookSilver(pipelineId)).body.round as { scheduledAt: string };

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect(session.scheduledAt?.toISOString()).toBe(round.scheduledAt);
  });

  it('gives the interview the round zone', async () => {
    const pipelineId = await pipelineAt('silver');
    await bookSilver(pipelineId);

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect(session.scheduledTimeZone).toBe('Asia/Kolkata');
  });

  it('emails the candidate their interview link with the time', async () => {
    const pipelineId = await pipelineAt('silver');
    mail.messages.length = 0;

    await bookSilver(pipelineId);

    const text = toCandidate().at(-1)?.text ?? '';
    expect({ time: /14:30.*Asia\/Kolkata/.test(text), portal: text.includes('/portal/') }).toEqual({ time: true, portal: true });
  });

  it('follows the interview when the interview is rescheduled', async () => {
    const pipelineId = await pipelineAt('silver');
    const roundId = (await bookSilver(pipelineId)).body.round.id as string;

    await request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth())
      .send({ date: futureDate(7), time: '09:15', timeZone: 'Europe/Berlin' });

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect({ at: round.scheduledAt.toISOString(), zone: round.scheduledTimeZone })
      .toEqual({ at: session.scheduledAt?.toISOString(), zone: 'Europe/Berlin' });
  });
});
