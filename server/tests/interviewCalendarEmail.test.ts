import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * What a candidate is actually able to tell about when their interview is.
 *
 * Two things have to be true at once. The body must carry a readable time,
 * because most people never open an attachment and some mail systems strip
 * them. And a calendar attachment must travel with it, because no email can
 * know what zone its reader is in — only the reader's own calendar can.
 */

interface SentAttachment { readonly filename: string; readonly content: string; readonly contentType: string }
interface Sent { to: string; subject: string; text: string; html: string; attachments?: readonly SentAttachment[] }

const mail = vi.hoisted(() => ({ delivers: true, messages: [] as Array<{ to: string; subject: string; text: string; html: string; attachments?: readonly { filename: string; content: string; contentType: string }[] }> }));

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: mail.delivers,
      async send(msg: Sent) {
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
const lastToCandidate = () => toCandidate().at(-1);
const calendarOf = (msg: Sent | undefined) => msg?.attachments?.find((f) => f.filename.endsWith('.ics'));

function icsProperty(ics: string, name: string): string | undefined {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n').find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

async function goldPipeline(): Promise<string> {
  const pipelineId = (await request(app).post('/api/pipelines').set(auth()).send({ candidateId: demo.candidateId })).body.pipeline.id as string;
  for (const key of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set(auth()).send({ toStageKey: key });
  }
  return pipelineId;
}

const bookGold = (pipelineId: string, extra: Record<string, unknown> = {}) =>
  request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth())
    .send({ stageKey: 'gold', date: futureDate(), time: '10:00', timeZone: 'America/New_York', interviewers: ['Hiring manager'], ...extra });

beforeEach(async () => {
  await wipe();
  mail.delivers = true;
  mail.messages.length = 0;
  demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  bearer = `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email })}`;
});

describe('the calendar attachment on a human round', () => {
  it('travels with the booking email', async () => {
    await bookGold(await goldPipeline());

    expect(calendarOf(lastToCandidate())).toBeTruthy();
  });

  it('asks the calendar to add the interview', async () => {
    await bookGold(await goldPipeline());

    expect(icsProperty(calendarOf(lastToCandidate())!.content, 'METHOD')).toBe('METHOD:REQUEST');
  });

  it('declares the same method in its MIME type as in its body', async () => {
    await bookGold(await goldPipeline());

    expect(calendarOf(lastToCandidate())!.contentType).toContain('method=REQUEST');
  });

  it('names only the candidate as an attendee', async () => {
    await bookGold(await goldPipeline());

    const attendees = calendarOf(lastToCandidate())!.content.split('\r\n').filter((l) => l.startsWith('ATTENDEE'));
    expect(attendees).toHaveLength(1);
  });

  it('keeps the readable time in the body as well as the attachment', async () => {
    await bookGold(await goldPipeline());

    expect(lastToCandidate()?.text ?? '').toMatch(/10:00.*America\/New_York/);
  });

  it('keeps one calendar entry across a reschedule instead of making a second', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    const booked = calendarOf(lastToCandidate())!.content;

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/reschedule`).set(auth())
      .send({ date: futureDate(6), time: '15:00', timeZone: 'America/New_York' });

    expect(icsProperty(calendarOf(lastToCandidate())!.content, 'UID')).toBe(icsProperty(booked, 'UID'));
  });

  it('raises the sequence on a reschedule, or Outlook would ignore it', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    const booked = Number(icsProperty(calendarOf(lastToCandidate())!.content, 'SEQUENCE')?.split(':')[1]);

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/reschedule`).set(auth())
      .send({ date: futureDate(6), time: '15:00', timeZone: 'America/New_York' });

    const moved = Number(icsProperty(calendarOf(lastToCandidate())!.content, 'SEQUENCE')?.split(':')[1]);
    expect(moved).toBeGreaterThan(booked);
  });

  it('withdraws the entry when the round is cancelled', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/cancel`).set(auth()).send({});

    const ics = calendarOf(lastToCandidate())!;
    expect([icsProperty(ics.content, 'METHOD'), icsProperty(ics.content, 'STATUS'), ics.contentType.includes('method=CANCEL')])
      .toEqual(['METHOD:CANCEL', 'STATUS:CANCELLED', true]);
  });

  it('puts the meeting link in the entry so the calendar can open it', async () => {
    await bookGold(await goldPipeline(), { meetingUrl: 'https://meet.example.com/abc' });

    expect(icsProperty(calendarOf(lastToCandidate())!.content, 'LOCATION')).toContain('https://meet.example.com/abc');
  });
});

describe('the candidate’s own clock', () => {
  it('is stated alongside the booking zone when HR recorded where they are', async () => {
    await prisma.candidate.update({ where: { id: demo.candidateId }, data: { timeZone: 'Asia/Kolkata' } });

    await bookGold(await goldPipeline());

    expect(lastToCandidate()?.text ?? '').toContain('Asia/Kolkata');
  });

  it('is left out rather than guessed when HR recorded nothing', async () => {
    await bookGold(await goldPipeline());

    expect(lastToCandidate()?.text ?? '').not.toMatch(/your own time zone/i);
  });

  it('is snapshotted onto the round, so moving later cannot re-date it', async () => {
    await prisma.candidate.update({ where: { id: demo.candidateId }, data: { timeZone: 'Asia/Kolkata' } });
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;

    await prisma.candidate.update({ where: { id: demo.candidateId }, data: { timeZone: 'Europe/London' } });

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
    expect(round.candidateTimeZone).toBe('Asia/Kolkata');
  });

  it('is taken again when the round is moved, because the time is being chosen again', async () => {
    await prisma.candidate.update({ where: { id: demo.candidateId }, data: { timeZone: 'Asia/Kolkata' } });
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    await prisma.candidate.update({ where: { id: demo.candidateId }, data: { timeZone: 'Europe/London' } });

    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/reschedule`).set(auth())
      .send({ date: futureDate(6), time: '15:00', timeZone: 'America/New_York' });

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
    expect(round.candidateTimeZone).toBe('Europe/London');
  });
});

describe('the calendar attachment on an AI interview invitation', () => {
  const invite = () => request(app).post(`/api/interviews/${demo.sessionId}/schedule`).set(auth())
    .send({ date: futureDate(), time: '14:30', timeZone: 'Asia/Kolkata', send: true });

  it('travels with the invitation when a time is booked', async () => {
    await invite();

    expect(calendarOf(lastToCandidate())).toBeTruthy();
  });

  it('is left off an invitation with no time, because there is nothing to add', async () => {
    await request(app).post(`/api/interviews/${demo.sessionId}/resend`).set(auth()).send({});

    expect(calendarOf(lastToCandidate())).toBeUndefined();
  });

  // Both entries can sit in one candidate's calendar at once, so a shared UID
  // would have the round quietly overwrite the interview.
  it('never shares a calendar identity with a pipeline round', async () => {
    await bookGold(await goldPipeline());
    const round = icsProperty(calendarOf(lastToCandidate())!.content, 'UID');

    await invite();

    expect(icsProperty(calendarOf(lastToCandidate())!.content, 'UID')).not.toBe(round);
  });

  it('snapshots the candidate zone onto the interview it schedules', async () => {
    await prisma.candidate.update({ where: { id: demo.candidateId }, data: { timeZone: 'Europe/Berlin' } });

    await invite();

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect(session.candidateTimeZone).toBe('Europe/Berlin');
  });
});
