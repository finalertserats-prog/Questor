import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { eraseCandidate } from '../src/services/dataRights.js';
import { deliverDueCalendarEntries } from '../src/services/calendarRetry.js';
import { MAX_CALENDAR_ATTEMPTS, staleCalendarEntries } from '../src/services/calendarDelivery.js';

/**
 * What happens to a calendar entry after a send fails.
 *
 * The sequence number a calendar update goes out under is INSIDE the .ics, so
 * it has to be spent before the send — there is no "send, then learn the
 * number". A failed send has therefore already burned its number, and the
 * recipient's calendar is left showing an older time. Nothing used to record
 * that: the recruiter was told "tell them yourself", which is about the email,
 * and the stale entry went unmentioned because nothing knew about it.
 *
 * The rule the retry must obey, and the reason this is not a generic outbox:
 * it rebuilds from the round as it stands at that moment. A queue that stored
 * the message and re-posted it would deliver the time the round had when the
 * send failed, which by then may be nobody's time at all.
 */

interface Sent { to: string; subject: string; text: string; html: string; attachments?: readonly { filename: string; content: string; contentType: string }[] }

const mail = vi.hoisted(() => ({
  delivers: true,
  failNext: false,
  messages: [] as Array<{ to: string; subject: string; text: string; html: string; attachments?: readonly { filename: string; content: string; contentType: string }[] }>,
}));

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: mail.delivers,
      async send(msg: Sent) {
        if (mail.failNext) throw new Error('the relay refused it');
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

const futureDate = (days = 5) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const toCandidate = () => mail.messages.filter((m) => m.to === CANDIDATE);
const calendarOf = (msg: Sent | undefined) => msg?.attachments?.find((f) => f.filename.endsWith('.ics'));

function icsProperty(ics: string, name: string): string | undefined {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n').find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

/** Whose calendar is out of step, narrowed to the interview a test is about. */
const behindFor = async (targetId: string) => (await staleCalendarEntries()).filter((s) => s.delivery.targetId === targetId);

const utcStamp = (at: Date) => `${at.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;

async function goldPipeline(): Promise<string> {
  const pipelineId = (await request(app).post('/api/pipelines').set(auth()).send({ candidateId: demo.candidateId })).body.pipeline.id as string;
  for (const key of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set(auth()).send({ toStageKey: key });
  }
  return pipelineId;
}

const bookGold = (pipelineId: string) =>
  request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth())
    .send({ stageKey: 'gold', date: futureDate(), time: '10:00', timeZone: 'America/New_York', interviewers: ['Hiring manager'] });

const move = (pipelineId: string, roundId: string, time: string, days = 6) =>
  request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/reschedule`).set(auth())
    .send({ date: futureDate(days), time, timeZone: 'America/New_York' });

beforeEach(async () => {
  await wipe();
  mail.delivers = true;
  mail.failNext = false;
  mail.messages.length = 0;
  demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  bearer = `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email })}`;
});

describe('a calendar entry that reached its recipient', () => {
  it('records what their calendar now holds', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    expect({ status: row.status, at: row.scheduledAtSent?.toISOString() })
      .toEqual({ status: 'SENT', at: round.scheduledAt.toISOString() });
  });

  it('records the sequence their calendar was told', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;

    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    const sent = Number(icsProperty(calendarOf(toCandidate().at(-1))!.content, 'SEQUENCE')?.split(':')[1]);
    expect(row.sequenceSent).toBe(sent);
  });

  it('keeps one row per person per interview, however often it moves', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;

    for (const time of ['15:00', '16:00']) await move(pipelineId, roundId, time);

    expect(await prisma.calendarDelivery.count({ where: { targetId: roundId } })).toBe(1);
  });

  it('is not reported as behind', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;

    expect(await behindFor(roundId)).toEqual([]);
  });
});

describe('a calendar entry whose send failed', () => {
  async function failedBooking(): Promise<{ pipelineId: string; roundId: string }> {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.failNext = true;
    await move(pipelineId, roundId, '15:00');
    mail.failNext = false;
    return { pipelineId, roundId };
  }

  it('is queued rather than forgotten', async () => {
    const { roundId } = await failedBooking();

    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    expect({ status: row.status, attempts: row.attempts }).toEqual({ status: 'QUEUED', attempts: 1 });
  });

  it('is reported as behind, which is what nothing used to know', async () => {
    const { roundId } = await failedBooking();

    expect((await behindFor(roundId)).map((s) => s.delivery.targetId)).toEqual([roundId]);
  });

  it('tells the recruiter what the candidate’s calendar still shows', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.failNext = true;

    const res = await move(pipelineId, roundId, '15:00');

    mail.failNext = false;
    expect(res.body.candidateNotice?.note ?? '').toMatch(/calendar still shows/);
  });

  it('is put right by the job', async () => {
    const { roundId } = await failedBooking();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    expect(row.status).toBe('SENT');
  });

  it('leaves nothing behind once it has been put right', async () => {
    const { roundId } = await failedBooking();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(await behindFor(roundId)).toEqual([]);
  });

  it('is not retried before its backoff is up', async () => {
    await failedBooking();
    const before = mail.messages.length;

    await deliverDueCalendarEntries(new Date());

    expect(mail.messages.length).toBe(before);
  });
});

/**
 * The property that makes this an outbox worth having rather than a hazard.
 */
describe('a round that moved again while its send was failing', () => {
  it('is corrected to where it is now, not to where it was', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.failNext = true;
    await move(pipelineId, roundId, '15:00');
    mail.failNext = false;
    // The round moves again. A queue replaying the failed message would send
    // 15:00; the round is at 17:00.
    await move(pipelineId, roundId, '17:00', 7);

    await deliverDueCalendarEntries(new Date(Date.now() + 7_200_000));

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
    expect(icsProperty(calendarOf(toCandidate().at(-1))!.content, 'DTSTART')).toBe(`DTSTART:${utcStamp(round.scheduledAt)}`);
  });

  it('records the time it actually delivered, not the one it owed', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.failNext = true;
    await move(pipelineId, roundId, '15:00');
    mail.failNext = false;
    await move(pipelineId, roundId, '17:00', 7);

    await deliverDueCalendarEntries(new Date(Date.now() + 7_200_000));

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    expect(row.scheduledAtSent?.toISOString()).toBe(round.scheduledAt.toISOString());
  });
});

/**
 * What the retry must read afresh, and what it must not carry over.
 *
 * Every queued row in here is produced by driving the real routes — book,
 * reschedule, cancel — and then letting the job run. Nothing below writes a
 * CalendarDelivery by hand, because the defects these cover are exactly the
 * kind a test that builds its own input cannot see.
 */
describe('a round cancelled while a correction was still owed', () => {
  async function owedThenCancelled(): Promise<string> {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    // A move whose notice fails: the row is queued carrying "moved".
    mail.failNext = true;
    await move(pipelineId, roundId, '15:00');
    mail.failNext = false;
    // The round is then cancelled with no mail provider that delivers, so the
    // cancellation reaches nobody and does not touch the queued row. The round
    // is cancelled all the same, which is the state the retry has to read.
    mail.delivers = false;
    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/cancel`).set(auth()).send({});
    mail.delivers = true;
    return roundId;
  }

  it('is still carrying the older intent when the retry picks it up', async () => {
    const roundId = await owedThenCancelled();

    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    expect({ status: row.status, kind: row.kind }).toEqual({ status: 'QUEUED', kind: 'moved' });
  });

  it('withdraws the entry rather than re-adding a meeting that is not happening', async () => {
    await owedThenCancelled();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(icsProperty(calendarOf(toCandidate().at(-1))!.content, 'METHOD')).toBe('METHOD:CANCEL');
  });

  it('marks the entry cancelled in its body as well as its method', async () => {
    await owedThenCancelled();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(icsProperty(calendarOf(toCandidate().at(-1))!.content, 'STATUS')).toBe('STATUS:CANCELLED');
  });

  it('declares the withdrawal in the MIME type too, or clients ignore it', async () => {
    await owedThenCancelled();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(calendarOf(toCandidate().at(-1))!.contentType).toContain('method=CANCEL');
  });

  it('tells the candidate in words that it is cancelled, not that it moved', async () => {
    await owedThenCancelled();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(toCandidate().at(-1)?.text ?? '').toMatch(/cancelled/i);
  });
});

/**
 * A CalendarDelivery row is ONE address's copy of an entry. Correcting it means
 * writing to that address — sending to whatever address the candidate has today
 * would leave the stale copy exactly where it was and then record it as fixed.
 *
 * (Questor has no route for changing a candidate's address, so that one step is
 * a direct write. Everything the retry actually reads — the round, the queued
 * row — still comes from the real routes.)
 */
describe('a candidate whose address changed while a correction was owed', () => {
  const MOVED_ON = 'priya.sharma@newaddress.example.com';

  async function owedThenMovedAddress(): Promise<string> {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.failNext = true;
    await move(pipelineId, roundId, '15:00');
    mail.failNext = false;
    await prisma.candidate.update({ where: { id: demo.candidateId }, data: { email: MOVED_ON, emailNormalized: MOVED_ON } });
    return roundId;
  }

  it('corrects the calendar that actually holds the stale entry', async () => {
    await owedThenMovedAddress();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(mail.messages.at(-1)?.to).toBe(CANDIDATE);
  });

  it('does not write to the new address instead', async () => {
    await owedThenMovedAddress();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(mail.messages.filter((m) => m.to === MOVED_ON)).toEqual([]);
  });

  it('resolves the row it was actually about', async () => {
    const roundId = await owedThenMovedAddress();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId, recipientEmail: CANDIDATE } });
    expect(row.status).toBe('SENT');
  });

  it('invents no row for an address that was never sent to', async () => {
    await owedThenMovedAddress();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(await prisma.calendarDelivery.count({ where: { recipientEmail: MOVED_ON } })).toBe(0);
  });
});

/**
 * The row names its target by type and id rather than by a foreign key, so
 * nothing in the database stops it outliving the interview. A row nothing
 * points at must not also be a row nothing looks for — it still holds a name
 * and an email address.
 */
describe('a delivery whose interview has gone', () => {
  it('is reported, rather than quietly counting as up to date', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    // A deletion path that does not clean up deliveries, which is exactly the
    // case a foreign key would have caught and there is none.
    const observations = await prisma.roundObservation.findMany({ where: { roundId }, select: { id: true } });
    const observationIds = observations.map((o) => o.id);
    await prisma.observationSegment.deleteMany({ where: { observationId: { in: observationIds } } });
    await prisma.observationParticipant.deleteMany({ where: { observationId: { in: observationIds } } });
    await prisma.roundObservation.deleteMany({ where: { roundId } });
    await prisma.roundInterviewer.deleteMany({ where: { roundId } });
    await prisma.interviewRound.delete({ where: { id: roundId } });

    expect((await behindFor(roundId)).map((e) => e.problem)).toEqual(['orphaned']);
  });
});

/**
 * The words have to be rebuilt too, not just the calendar entry.
 *
 * Fixing the METHOD for cancellation left the same defect one status value
 * away: a retry kept the intent it was queued with for every round that was
 * not cancelled. So a "your meeting link is ready" notice that failed, on a
 * round that then moved, would retry with the new time in the .ics and the old
 * sentence in the body — the message saying one thing in its words and another
 * in its calendar entry, which is the thing this whole area exists to stop.
 */
describe('a notice queued for one reason and retried after another', () => {
  async function linkOwedThenMoved(): Promise<string> {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    // A meeting link whose notice fails: queued carrying "link".
    mail.failNext = true;
    await request(app).put(`/api/pipelines/${pipelineId}/rounds/${roundId}/meeting-link`).set(auth())
      .send({ url: 'https://meet.example.com/ready' });
    mail.failNext = false;
    // The round then moves with no delivering provider, so that notice reaches
    // nobody and leaves the queued row untouched — still saying "link".
    mail.delivers = false;
    await move(pipelineId, roundId, '15:00');
    mail.delivers = true;
    return roundId;
  }

  it('is still carrying the older reason when the retry picks it up', async () => {
    const roundId = await linkOwedThenMoved();

    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    expect({ status: row.status, kind: row.kind }).toEqual({ status: 'QUEUED', kind: 'link' });
  });

  it('tells the candidate their interview moved, which is what actually happened', async () => {
    await linkOwedThenMoved();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(toCandidate().at(-1)?.text ?? '').toMatch(/has moved/);
  });

  it('does not announce a meeting link as though nothing else had changed', async () => {
    await linkOwedThenMoved();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    expect(toCandidate().at(-1)?.text ?? '').not.toMatch(/Here is the meeting link/);
  });

  it('carries the new time in the calendar entry as well as in the words', async () => {
    const roundId = await linkOwedThenMoved();

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
    expect(icsProperty(calendarOf(toCandidate().at(-1))!.content, 'DTSTART')).toBe(`DTSTART:${utcStamp(round.scheduledAt)}`);
  });

  it('reads as a first booking when nothing has ever reached that calendar', async () => {
    const pipelineId = await goldPipeline();
    mail.failNext = true;
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.failNext = false;

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    expect({ sent: row.status, words: /is booked for/.test(toCandidate().at(-1)?.text ?? '') })
      .toEqual({ sent: 'SENT', words: true });
  });
});

describe('an interview that lost its time while somebody held an entry', () => {
  it('is reported, because their calendar still shows a meeting', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    // Rounds always hold a time; an AI interview does not have to, so this is
    // the shape of row that can outlive the booking it describes.
    await prisma.calendarDelivery.update({ where: { id: row.id }, data: { targetType: 'interview', targetId: demo.sessionId } });
    await prisma.interviewSession.update({ where: { id: demo.sessionId }, data: { scheduledAt: null } });

    expect((await behindFor(demo.sessionId)).map((e) => e.problem)).toEqual(['behind']);
  });
});

describe('an entry that keeps failing', () => {
  it('stops asking after enough attempts, and says so', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.failNext = true;
    await move(pipelineId, roundId, '15:00');

    // Every remaining attempt, each well past its own backoff.
    for (let n = 1; n < MAX_CALENDAR_ATTEMPTS; n += 1) {
      await deliverDueCalendarEntries(new Date(Date.now() + (n + 1) * 24 * 3_600_000));
    }
    mail.failNext = false;

    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    expect({ status: row.status, error: row.lastError }).toEqual({ status: 'FAILED', error: 'the relay refused it' });
  });

  it('stops chasing a round whose time has passed', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    mail.failNext = true;
    await move(pipelineId, roundId, '15:00');
    mail.failNext = false;
    await prisma.interviewRound.update({ where: { id: roundId }, data: { scheduledAt: new Date(Date.now() - 86_400_000) } });

    await deliverDueCalendarEntries(new Date(Date.now() + 3_600_000));

    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    expect({ status: row.status, chasing: row.nextAttemptAt }).toEqual({ status: 'FAILED', chasing: null });
  });
});

describe('a claim whose worker died', () => {
  it('is put back rather than left held for ever', async () => {
    const pipelineId = await goldPipeline();
    const roundId = (await bookGold(pipelineId)).body.round.id as string;
    const row = await prisma.calendarDelivery.findFirstOrThrow({ where: { targetId: roundId } });
    await prisma.calendarDelivery.update({
      where: { id: row.id },
      data: { status: 'SENDING', claimedAt: new Date(Date.now() - 3_600_000), nextAttemptAt: null },
    });

    await deliverDueCalendarEntries(new Date());

    const after = await prisma.calendarDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).not.toBe('SENDING');
  });
});

/**
 * CalendarDelivery names its target by type and id rather than by a foreign
 * key, because the target is one of two tables. Nothing in the database
 * therefore stops these rows outliving the interview — and each one holds a
 * person's name and email address. This test is the constraint.
 */
describe('erasing a candidate', () => {
  it('takes their calendar deliveries with them', async () => {
    const pipelineId = await goldPipeline();
    await bookGold(pipelineId);
    const theirs = { recipientEmail: CANDIDATE };
    expect(await prisma.calendarDelivery.count({ where: theirs })).toBeGreaterThan(0);

    const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
    await eraseCandidate({ candidateId: demo.candidateId, tenantId: demo.tenantId, actorId: user.id, reason: 'erasure request' });

    expect(await prisma.calendarDelivery.count({ where: theirs })).toBe(0);
  });
});
