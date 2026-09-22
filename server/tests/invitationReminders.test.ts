import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { invitationSecretColumns, mintInvitationToken } from '../src/services/invitations.js';
import { candidateStageDue, recruiterWarningDue, runInvitationReminders } from '../src/services/invitationReminders.js';

// HR-Box reminders: the candidate at day 3 and day 10 of the 14-day
// invitation, the owning recruiter two days before it closes. Each at most
// once, never to someone who has started, been decided or asked for a person.

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

beforeEach(async () => {
  await wipe();
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
