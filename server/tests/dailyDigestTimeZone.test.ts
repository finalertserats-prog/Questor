import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { runDailyDigest } from '../src/services/dailyDigest.js';

/**
 * The daily summary follows the reader's clock, not the organisation's.
 *
 * It used to fire once per organisation, at DIGEST_HOUR on the organisation's
 * own clock, and call the result "today". For a recruiter or an expert in
 * London attached to an India-based organisation that arrived at about half
 * past two in the morning, and the "today" in it was Bengaluru's. The whole
 * point of a morning summary is that it is read in the morning.
 *
 * The three properties this must not lose while moving: it is claimed before
 * it is sent, so nobody gets two; it is never sent in the middle of the night,
 * so a missed morning is dropped rather than delivered at 3am; and a person who
 * switched it off still gets nothing.
 */

const mail = vi.hoisted(() => ({ messages: [] as Array<{ to: string; subject: string; text: string; html: string }> }));

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        mail.messages.push(msg);
        return { status: 'sent', id: `test-${mail.messages.length}` };
      },
    }),
  };
});

const DAY = 86_400_000;
/** 09:00 in Kolkata, 04:30 in London: the organisation's morning, not London's. */
const KOLKATA_MORNING = new Date('2026-09-23T03:30:00.000Z');
/** 09:30 in London, 14:00 in Kolkata: past the organisation's window, inside London's. */
const LONDON_MORNING = new Date('2026-09-23T08:30:00.000Z');

async function setup(opts: { orgZone?: string; userZone?: string | null } = {}) {
  const tenant = await prisma.tenant.create({
    data: { name: 'Acme', policyJson: JSON.stringify(opts.orgZone ? { timeZone: opts.orgZone } : {}) },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id, email: 'sam@acme.local', name: 'Sam Reeve', passwordHash: 'x',
      role: 'recruiter', timeZone: opts.userZone ?? null,
    },
  });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
  await prisma.roleAssignment.create({ data: { roleId: role.id, userId: user.id } });
  const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
  const candidate = await prisma.candidate.create({ data: { tenantId: tenant.id, roleId: role.id, fullName: 'Daniel Okafor', email: 'd@m.local' } });
  await prisma.interviewSession.create({
    data: {
      tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id,
      state: 'INCOMPLETE', interruptedAt: new Date(KOLKATA_MORNING.getTime() - DAY),
    },
  });
  return { tenant, user };
}

beforeEach(async () => {
  await wipe();
  mail.messages = [];
});

describe('a reader in another country', () => {
  it('is not sent their summary in the middle of their night', async () => {
    await setup({ orgZone: 'Asia/Kolkata', userZone: 'Europe/London' });

    await runDailyDigest(null, KOLKATA_MORNING);

    expect(mail.messages).toHaveLength(0);
  });

  it('is sent it in their own morning, after the organisation’s window has closed', async () => {
    await setup({ orgZone: 'Asia/Kolkata', userZone: 'Europe/London' });

    await runDailyDigest(null, LONDON_MORNING);

    expect(mail.messages).toHaveLength(1);
  });

  it('still gets it only once for their day', async () => {
    await setup({ orgZone: 'Asia/Kolkata', userZone: 'Europe/London' });

    await runDailyDigest(null, LONDON_MORNING);
    await runDailyDigest(null, new Date(LONDON_MORNING.getTime() + 3_600_000));

    expect(mail.messages).toHaveLength(1);
  });

  it('claims the day on their calendar, not the organisation’s', async () => {
    // Kolkata's morning of the 23rd is still the evening of the 22nd in
    // California, so the organisation's day and the reader's disagree.
    await setup({ orgZone: 'America/Los_Angeles', userZone: 'Asia/Kolkata' });

    await runDailyDigest(null, KOLKATA_MORNING);

    const delivery = await prisma.digestDelivery.findFirstOrThrow({});
    expect(delivery.day).toBe('2026-09-23');
  });

  it('is never sent at night just because the organisation’s morning came round', async () => {
    // 09:00 in Kolkata is 20:30 the previous evening in Los Angeles.
    await setup({ orgZone: 'Asia/Kolkata', userZone: 'America/Los_Angeles' });

    await runDailyDigest(null, KOLKATA_MORNING);

    expect(mail.messages).toHaveLength(0);
  });
});

describe('a reader who has not set a time zone', () => {
  it('is sent it on the organisation’s clock, as before', async () => {
    await setup({ orgZone: 'Asia/Kolkata', userZone: null });

    await runDailyDigest(null, KOLKATA_MORNING);

    expect(mail.messages).toHaveLength(1);
  });

  it('is told which clock it was written on, rather than left to assume', async () => {
    await setup({ orgZone: 'Asia/Kolkata', userZone: null });

    await runDailyDigest(null, KOLKATA_MORNING);

    expect(mail.messages[0]?.text ?? '').toContain('Asia/Kolkata');
  });

  it('is told nothing about zones once they have set their own', async () => {
    await setup({ orgZone: 'Asia/Kolkata', userZone: 'Asia/Kolkata' });

    await runDailyDigest(null, KOLKATA_MORNING);

    expect(mail.messages[0]?.text ?? '').not.toContain('organisation’s time zone');
  });
});

/**
 * A reader who crosses the date line.
 *
 * Keying the once-a-day claim on the reader's own calendar date is what makes
 * "today" mean their today — but a calendar date is not monotonic when the
 * person carrying it gets on a plane. Flying east, their local date jumps
 * forward, which is a brand-new key hours after the last summary went out; the
 * claim alone would happily allow a second one the same morning.
 */
describe('a reader who moves between zones', () => {
  /** 09:00 in Los Angeles on the 23rd. */
  const LA_MORNING = new Date('2026-09-23T16:00:00.000Z');
  /** Two hours later — and already 08:00 on the 24th in Kiritimati. */
  const TWO_HOURS_ON = new Date('2026-09-23T18:00:00.000Z');

  it('is not sent a second summary hours later under a new calendar date', async () => {
    const { user } = await setup({ orgZone: 'Asia/Kolkata', userZone: 'America/Los_Angeles' });
    await runDailyDigest(null, LA_MORNING);
    expect(mail.messages).toHaveLength(1);

    await prisma.user.update({ where: { id: user.id }, data: { timeZone: 'Pacific/Kiritimati' } });
    await runDailyDigest(null, TWO_HOURS_ON);

    expect(mail.messages).toHaveLength(1);
  });

  it('claims nothing for the day it declined to send on', async () => {
    const { user } = await setup({ orgZone: 'Asia/Kolkata', userZone: 'America/Los_Angeles' });
    await runDailyDigest(null, LA_MORNING);
    await prisma.user.update({ where: { id: user.id }, data: { timeZone: 'Pacific/Kiritimati' } });

    await runDailyDigest(null, TWO_HOURS_ON);

    expect(await prisma.digestDelivery.count()).toBe(1);
  });
});

/**
 * The gap that stops a second summary must never stop a first one.
 *
 * The window is six hours wide, so two consecutive days' summaries can be as
 * little as eighteen hours apart — the latest possible moment on one day and
 * the earliest on the next. Anything longer than that as a cooling-off period
 * would silently drop a legitimate morning.
 */
describe('the tightest legitimate pair of mornings', () => {
  /** 13:30 in Kolkata: the last half-hour of a window that opened at 08:00. */
  const LATE_IN_THE_WINDOW = new Date('2026-09-23T08:00:00.000Z');
  /** 08:00 in Kolkata the next day: the first minute of the next window. */
  const EARLIEST_NEXT_DAY = new Date('2026-09-24T02:30:00.000Z');

  it('still sends both', async () => {
    await setup({ orgZone: 'Asia/Kolkata', userZone: 'Asia/Kolkata' });

    await runDailyDigest(null, LATE_IN_THE_WINDOW);
    await runDailyDigest(null, EARLIEST_NEXT_DAY);

    expect(mail.messages).toHaveLength(2);
  });
});

describe('what per-reader timing must not break', () => {
  it('still sends nothing to someone who switched the summary off', async () => {
    const { user } = await setup({ orgZone: 'Asia/Kolkata', userZone: 'Europe/London' });
    await prisma.user.update({ where: { id: user.id }, data: { digestOptOut: true } });

    await runDailyDigest(null, LONDON_MORNING);

    expect(mail.messages).toHaveLength(0);
  });

  it('still sends on the next day of the reader’s own calendar', async () => {
    await setup({ orgZone: 'Asia/Kolkata', userZone: 'Europe/London' });

    await runDailyDigest(null, LONDON_MORNING);
    await runDailyDigest(null, new Date(LONDON_MORNING.getTime() + DAY));

    expect(mail.messages).toHaveLength(2);
  });
});
