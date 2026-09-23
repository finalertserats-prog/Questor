import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { config, parseRemindersStartAt } from '../src/config.js';
import { wipe } from '../src/seed/demoData.js';
import { invitationSecretColumns, mintInvitationToken } from '../src/services/invitations.js';
import { candidateStageDue, recruiterWarningDue, remindersActiveFrom, runInvitationReminders } from '../src/services/invitationReminders.js';

// HR-Box reminders: the candidate at day 3 and day 10 of the 14-day
// invitation, the owning recruiter two days before it closes. Each at most
// once, never to someone who has started, been decided or asked for a person,
// and never for an invitation sent before reminders were switched on.

const mail = vi.hoisted(() => ({
  delivers: true,
  fail: false,
  messages: [] as Array<{ to: string; subject: string; text: string; html: string }>,
}));

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, get delivers() { return mail.delivers; },
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        if (mail.fail) throw new Error('smtp down');
        mail.messages.push(msg);
        return { status: 'sent', id: `test-${mail.messages.length}` };
      },
    }),
  };
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = 14 * DAY;

async function setup(opts: { isDemo?: boolean } = {}) {
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', isDemo: opts.isDemo ?? false } });
  const recruiter = await prisma.user.create({ data: { tenantId: tenant.id, email: 'kavya@acme.local', name: 'Kavya Sharma', passwordHash: 'x', role: 'recruiter' } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
  const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
  const candidate = await prisma.candidate.create({ data: { tenantId: tenant.id, roleId: role.id, fullName: 'Sofia Alvarez', email: 'sofia@m.local' } });
  await prisma.candidateAssignment.create({ data: { candidateId: candidate.id, userId: recruiter.id, relation: 'owner' } });
  return { tenant, recruiter, role, scorecard, candidate };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** An invitation sent `dayOfWindow` days ago, 14-day window, candidate not started. */
async function invite(s: Setup, dayOfWindow: number, state = 'INVITED') {
  const session = await prisma.interviewSession.create({
    data: { tenantId: s.tenant.id, candidateId: s.candidate.id, roleId: s.role.id, scorecardId: s.scorecard.id, state },
  });
  const sentAt = new Date(Date.now() - dayOfWindow * DAY);
  const invitation = await prisma.invitation.create({
    data: { sessionId: session.id, ...invitationSecretColumns(mintInvitationToken()), status: 'sent', sentAt, expiresAt: new Date(sentAt.getTime() + WINDOW) },
  });
  return { session, invitation };
}

const toCandidate = () => mail.messages.filter((m) => m.to === 'sofia@m.local');
const toRecruiter = () => mail.messages.filter((m) => m.to === 'kavya@acme.local');

/**
 * Reminders have been on since `days` ago. Written straight to the table:
 * without it, the first run would stamp "now" and every fixture here — all of
 * them sent days ago — would be on the wrong side of the cutoff. The cutoff
 * itself has its own block at the foot of this file.
 */
async function remindersOnSince(days: number) {
  const activeFrom = new Date(Date.now() - days * DAY);
  await prisma.reminderWindow.upsert({ where: { id: 'reminders' }, update: { activeFrom }, create: { id: 'reminders', activeFrom } });
}

beforeEach(async () => {
  await wipe();
  await remindersOnSince(365);
  config.hrBox.remindersStartAt = null;
  mail.delivers = true;
  mail.fail = false;
  mail.messages = [];
});

describe('when a candidate reminder is due', () => {
  const expires = new Date('2026-10-01T00:00:00.000Z');
  const onDay = (day: number) => new Date(expires.getTime() - WINDOW + day * DAY);

  it('is nothing before day 3', () => {
    expect(candidateStageDue(expires, onDay(2.9))).toBeNull();
  });

  it('is the day-3 note from day 3', () => {
    expect(candidateStageDue(expires, onDay(3))).toBe('day3');
  });

  it('is only the day-10 note once day 10 is reached', () => {
    expect(candidateStageDue(expires, onDay(11))).toBe('day10');
  });

  it('is nothing once the link has expired', () => {
    expect(candidateStageDue(expires, onDay(14))).toBeNull();
  });

  it('warns the recruiter inside the last two days', () => {
    expect([recruiterWarningDue(expires, onDay(11.5)), recruiterWarningDue(expires, onDay(12.5))]).toEqual([false, true]);
  });
});

describe('candidate reminders', () => {
  it('sends the day-3 reminder once, however often the job runs', async () => {
    const s = await setup();
    await invite(s, 3.5);
    await runInvitationReminders();
    await runInvitationReminders();
    expect(toCandidate().length).toBe(1);
  });

  it('writes the reminder warmly, with the link', async () => {
    const s = await setup();
    await invite(s, 3.5);
    await runInvitationReminders();
    expect([toCandidate()[0].subject, /\/portal\/[A-Za-z0-9_-]+/.test(toCandidate()[0].text)]).toEqual(['A reminder: your interview for Data Engineer at Acme', true]);
  });

  it('says the day-10 reminder is the last one', async () => {
    const s = await setup();
    await invite(s, 10.5);
    await runInvitationReminders();
    expect(toCandidate()[0].text).toContain('This is the last reminder we will send.');
  });

  it('records and audits what it sent', async () => {
    const s = await setup();
    const { session } = await invite(s, 3.5);
    await runInvitationReminders();
    const [row, audit] = await Promise.all([
      prisma.invitationReminder.findFirst({ where: { sessionId: session.id } }),
      prisma.auditEvent.findFirst({ where: { action: 'invitation.reminder_sent', entityId: session.id } }),
    ]);
    expect([row?.kind, row?.status, audit?.actorType]).toEqual(['candidate_day3', 'sent', 'system']);
  });

  it('sends nothing before day 3', async () => {
    const s = await setup();
    await invite(s, 2);
    await runInvitationReminders();
    expect(toCandidate()).toEqual([]);
  });

  it('sends nothing to a candidate who has started', async () => {
    const s = await setup();
    await invite(s, 3.5, 'ASSESSING');
    await runInvitationReminders();
    expect(toCandidate()).toEqual([]);
  });

  it('sends nothing once the application is decided', async () => {
    const s = await setup();
    await invite(s, 3.5);
    await prisma.candidatePipeline.create({ data: { tenantId: s.tenant.id, candidateId: s.candidate.id, roleId: s.role.id, stagesJson: '[]', currentStageKey: 'bronze', status: 'DECIDED', decision: 'WITHDRAWN' } });
    await runInvitationReminders();
    expect(toCandidate()).toEqual([]);
  });

  it('sends nothing to a candidate who asked to talk to a person', async () => {
    const s = await setup();
    const { session } = await invite(s, 3.5);
    await prisma.candidateHumanRequest.create({ data: { tenantId: s.tenant.id, candidateId: s.candidate.id, sessionId: session.id, tokenHash: 'hr-1', expiresAt: new Date(Date.now() + DAY), status: 'REQUESTED', requestedAt: new Date() } });
    await runInvitationReminders();
    expect(toCandidate()).toEqual([]);
  });

  it('sends nothing in a demo sandbox', async () => {
    const s = await setup({ isDemo: true });
    await invite(s, 3.5);
    await runInvitationReminders();
    expect(mail.messages).toEqual([]);
  });

  it('sends nothing the day after the invitation was resent', async () => {
    const s = await setup();
    const { invitation } = await invite(s, 3.5);
    await prisma.invitation.update({ where: { id: invitation.id }, data: { sentAt: new Date(Date.now() - HOUR) } });
    await runInvitationReminders();
    expect(toCandidate()).toEqual([]);
  });

  it('claims nothing while email cannot be delivered, so it goes once it can', async () => {
    const s = await setup();
    await invite(s, 3.5);
    mail.delivers = false;
    await runInvitationReminders();
    mail.delivers = true;
    await runInvitationReminders();
    expect(toCandidate().length).toBe(1);
  });

  it('does not retry a reminder whose send failed', async () => {
    const s = await setup();
    const { session } = await invite(s, 3.5);
    mail.fail = true;
    await runInvitationReminders();
    mail.fail = false;
    await runInvitationReminders();
    const row = await prisma.invitationReminder.findFirst({ where: { sessionId: session.id, recipientKey: 'candidate' } });
    expect([toCandidate().length, row?.status]).toEqual([0, 'failed']);
  });

  it('gives a fresh invitation its own reminders', async () => {
    const s = await setup();
    const { invitation } = await invite(s, 3.5);
    await runInvitationReminders();
    const reissued = new Date(Date.now() - 3.5 * DAY);
    await prisma.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(reissued.getTime() + WINDOW + HOUR), sentAt: reissued } });
    await runInvitationReminders();
    expect(toCandidate().length).toBe(2);
  });
});

describe('recruiter expiry warning', () => {
  it('warns the owning recruiter once, two days before it closes', async () => {
    const s = await setup();
    await invite(s, 12.5);
    await runInvitationReminders();
    await runInvitationReminders();
    expect(toRecruiter().map((m) => m.subject)).toEqual(['Invitation closing soon: Sofia Alvarez, Data Engineer']);
  });

  it('does not warn while more than two days are left', async () => {
    const s = await setup();
    await invite(s, 11);
    await runInvitationReminders();
    expect(toRecruiter()).toEqual([]);
  });

  it('falls back to the role owner when nobody owns the candidate', async () => {
    const s = await setup();
    await prisma.candidateAssignment.deleteMany({});
    await prisma.roleAssignment.create({ data: { roleId: s.role.id, userId: s.recruiter.id, relation: 'owner' } });
    await invite(s, 12.5);
    await runInvitationReminders();
    expect(toRecruiter().length).toBe(1);
  });
});

describe('the cutoff: only invitations sent after reminders were switched on', () => {
  /** Nothing has ever run: the table has no stamp, as production does not today. */
  const switchNotYetThrown = () => prisma.reminderWindow.deleteMany();

  it('stamps the moment of the first run', async () => {
    await switchNotYetThrown();
    const before = Date.now();
    await runInvitationReminders();
    const row = await prisma.reminderWindow.findUnique({ where: { id: 'reminders' } });
    expect(row?.activeFrom.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('never moves the stamp once it is written', async () => {
    await switchNotYetThrown();
    await runInvitationReminders();
    const first = await prisma.reminderWindow.findUnique({ where: { id: 'reminders' } });
    await runInvitationReminders();
    const second = await prisma.reminderWindow.findUnique({ where: { id: 'reminders' } });
    expect(second?.activeFrom.getTime()).toBe(first?.activeFrom.getTime());
  });

  it('stamps even on a run that cannot mail, so a later run cannot draw the line somewhere else', async () => {
    await switchNotYetThrown();
    mail.delivers = false;
    await runInvitationReminders();
    expect(await prisma.reminderWindow.count()).toBe(1);
  });

  it('leaves an invitation already past day 3 alone when the switch is thrown', async () => {
    const s = await setup();
    await invite(s, 3.5);
    await switchNotYetThrown();
    await runInvitationReminders();
    expect(toCandidate()).toEqual([]);
  });

  it('leaves it alone on every later run too', async () => {
    const s = await setup();
    await invite(s, 10.5);
    await switchNotYetThrown();
    await runInvitationReminders();
    await runInvitationReminders();
    await runInvitationReminders();
    expect(toCandidate()).toEqual([]);
  });

  it('never warns the recruiter about an invitation from before the switch', async () => {
    const s = await setup();
    await invite(s, 12.5);
    await switchNotYetThrown();
    await runInvitationReminders();
    expect(toRecruiter()).toEqual([]);
  });

  it('reminds an invitation sent after the switch', async () => {
    // The switch was thrown five days ago; this invitation went out since.
    await remindersOnSince(5);
    const s = await setup();
    await invite(s, 3.5);
    await runInvitationReminders();
    expect(toCandidate().length).toBe(1);
  });

  it('chases an old invitation once it is resent after the switch, because that is a fresh send', async () => {
    await remindersOnSince(5);
    const s = await setup();
    const { invitation } = await invite(s, 10.5);
    await runInvitationReminders();
    expect(toCandidate()).toEqual([]);
    // POST /interviews/:id/resend moves sentAt and leaves the expiry alone, so
    // the stage is still counted from the original window: the day-10 note.
    await prisma.invitation.update({ where: { id: invitation.id }, data: { sentAt: new Date(Date.now() - 2 * DAY) } });
    await runInvitationReminders();
    expect([toCandidate().length, toCandidate()[0]?.text.includes('This is the last reminder we will send.')]).toEqual([1, true]);
  });

  it('holds an invitation the recruiter has not resent, in the same run as one they have', async () => {
    await remindersOnSince(5);
    const s = await setup();
    const { invitation } = await invite(s, 10.5);
    const other = await prisma.candidate.create({ data: { tenantId: s.tenant.id, roleId: s.role.id, fullName: 'Ravi Menon', email: 'ravi@m.local' } });
    await invite({ ...s, candidate: other }, 10.5);
    await runInvitationReminders();
    await prisma.invitation.update({ where: { id: invitation.id }, data: { sentAt: new Date(Date.now() - 2 * DAY) } });
    await runInvitationReminders();
    expect(mail.messages.map((m) => m.to)).toEqual(['sofia@m.local']);
  });

  it('reads REMINDERS_START_AT as a date or a date-time, and a bare date as midnight UTC', () => {
    expect([parseRemindersStartAt(undefined), parseRemindersStartAt('2026-09-24')?.toISOString(), parseRemindersStartAt('2026-09-24T09:30:00Z')?.toISOString()])
      .toEqual([null, '2026-09-24T00:00:00.000Z', '2026-09-24T09:30:00.000Z']);
  });

  it('refuses a REMINDERS_START_AT it cannot read, rather than reminding everyone', () => {
    expect(() => parseRemindersStartAt('next tuesday')).toThrow(/REMINDERS_START_AT/);
  });

  it('takes REMINDERS_START_AT over the stamp', async () => {
    await remindersOnSince(365);
    config.hrBox.remindersStartAt = new Date(Date.now() - DAY);
    const s = await setup();
    await invite(s, 3.5);
    await runInvitationReminders();
    expect(toCandidate()).toEqual([]);
  });

  it('leaves the stamp in place while REMINDERS_START_AT is set, so removing it goes back to the stamp', async () => {
    await remindersOnSince(365);
    const stamped = await prisma.reminderWindow.findUnique({ where: { id: 'reminders' } });
    config.hrBox.remindersStartAt = new Date(Date.now() - DAY);
    await runInvitationReminders();
    config.hrBox.remindersStartAt = null;
    expect((await remindersActiveFrom(new Date())).getTime()).toBe(stamped?.activeFrom.getTime());
  });
});
