import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { digestDayFor, runDailyDigest } from '../src/services/dailyDigest.js';
import { waitedFor } from '../src/providers/email/digestEmail.js';
import { parseDigestHour } from '../src/config.js';

// The HR-Box daily summary: each HR user's "Needs you" rows by email, once a
// day from DIGEST_HOUR on the organisation's clock, never when nothing waits,
// never to someone who switched it off.

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

const app = createApp();
const DAY = 86_400_000;
// 09:00 in Kolkata (the default organisation zone), past the default 08:00.
const MORNING = new Date('2026-09-23T03:30:00.000Z');

async function setup(opts: { digestOptOut?: boolean; withWork?: boolean } = {}) {
  const tenant = await prisma.tenant.create({ data: { name: 'Acme' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email: 'kavya@acme.local', name: 'Kavya Sharma', passwordHash: 'x', role: 'recruiter', digestOptOut: opts.digestOptOut ?? false } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
  await prisma.roleAssignment.create({ data: { roleId: role.id, userId: user.id } });
  if (opts.withWork ?? true) {
    const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
    const candidate = await prisma.candidate.create({ data: { tenantId: tenant.id, roleId: role.id, fullName: 'Daniel Okafor', email: 'd@m.local' } });
    await prisma.interviewSession.create({ data: { tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id, state: 'INCOMPLETE', interruptedAt: new Date(MORNING.getTime() - DAY) } });
  }
  return { tenant, user, token: signToken({ userId: user.id, tenantId: tenant.id, role: 'recruiter', email: user.email }) };
}

beforeEach(async () => {
  await wipe();
  mail.messages = [];
});

describe('daily summary timing', () => {
  it('is due from the digest hour on the organisation clock', () => {
    expect(digestDayFor(MORNING, 'Asia/Kolkata', 8)).toBe('2026-09-23');
  });

  it('is not due late at night when the morning was missed', () => {
    expect(digestDayFor(MORNING, 'America/New_York', 8)).toBeNull();
  });

  it('is not due before the digest hour', () => {
    expect(digestDayFor(new Date('2026-09-23T01:00:00.000Z'), 'Asia/Kolkata', 8)).toBeNull();
  });

  it('refuses a digest hour that is not a whole hour of the day', () => {
    expect(() => parseDigestHour('25')).toThrow(/DIGEST_HOUR/);
  });

  it('writes waits in the units a person reads', () => {
    expect([waitedFor(new Date(0), new Date(18 * 60_000)), waitedFor(new Date(0), new Date(3 * 3_600_000)), waitedFor(new Date(0), new Date(5 * DAY))]).toEqual(['18 min', '3 h', '5 days']);
  });
});

describe('daily summary', () => {
  it('sends what needs the user, once a day', async () => {
    await setup();
    await runDailyDigest(null, MORNING);
    await runDailyDigest(null, new Date(MORNING.getTime() + 3_600_000));
    expect(mail.messages.map((m) => m.subject)).toEqual(['Questor: one thing needs you today']);
  });

  it('names the row and links to where it is dealt with', async () => {
    await setup();
    await runDailyDigest(null, MORNING);
    expect(mail.messages[0].text).toMatch(/Interview stopped part-way: Daniel Okafor, Data Engineer\. Waiting 24 h\. http:\/\/localhost:5173\/interviews\//);
  });

  it('sends the next day again', async () => {
    await setup();
    await runDailyDigest(null, MORNING);
    await runDailyDigest(null, new Date(MORNING.getTime() + DAY));
    expect(mail.messages.length).toBe(2);
  });

  it('sends nothing when nothing waits', async () => {
    await setup({ withWork: false });
    await runDailyDigest(null, MORNING);
    expect(mail.messages).toEqual([]);
  });

  it('sends nothing to someone who switched it off', async () => {
    await setup({ digestOptOut: true });
    await runDailyDigest(null, MORNING);
    expect(mail.messages).toEqual([]);
  });

  it('sends nothing to an auditor, who cannot act on candidates', async () => {
    const s = await setup();
    await prisma.user.update({ where: { id: s.user.id }, data: { role: 'auditor' } });
    await runDailyDigest(null, MORNING);
    expect(mail.messages).toEqual([]);
  });
});

describe('the summary switch in Settings', () => {
  it('turns the summary off for the caller', async () => {
    const s = await setup();
    await request(app).patch('/api/auth/me/preferences').set('Authorization', `Bearer ${s.token}`).send({ digestOptOut: true });
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${s.token}`);
    expect(me.body.user.digestOptOut).toBe(true);
  });

  it('refuses a field it does not know', async () => {
    const s = await setup();
    const res = await request(app).patch('/api/auth/me/preferences').set('Authorization', `Bearer ${s.token}`).send({ digestOptOut: true, role: 'admin' });
    expect(res.status).toBe(400);
  });
});
