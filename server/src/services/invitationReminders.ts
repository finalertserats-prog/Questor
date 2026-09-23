import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getEmail } from '../providers/email/index.js';
import { buildCandidateReminder, buildRecruiterExpiryWarning, type CandidateReminderStage } from '../providers/email/reminderEmail.js';
import { capabilitiesOf } from '../domain/capabilities.js';
import { logAudit } from './audit.js';
import { demoRecipientBlocked } from './demoPolicy.js';
import { invitationLink } from './invitations.js';
import { startJob, type LeaseHandle } from './jobs.js';
import { tenantTimeZone } from './tenantTimeZone.js';
import { NOT_STARTED_STATES } from '../domain/needsYou.js';

/**
 * HR-Box reminders (REMINDERS_ENABLED, off by default).
 *
 * A candidate who has not started gets two warm reminders, at day 3 and day 10
 * of the 14-day invitation; the recruiters who own the candidate get one
 * warning about two days before it closes. Each is claimed as an
 * InvitationReminder row before the email goes. The row's unique key is what
 * makes this safe to restart and to run on several instances: a reminder is
 * sent at most once, and a crash between the claim and the send loses that
 * reminder rather than sending it twice.
 *
 * Never after the link has expired, the interview has started or finished, the
 * application was decided, the role was archived, or the candidate asked to
 * talk to a person; never in a demo sandbox.
 *
 * And never for an invitation whose latest send predates the moment reminders
 * were switched on — see remindersActiveFrom. Throwing the switch must not
 * mail everyone already past day 3 or day 10.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** routes/interviews.ts inviteSession: every invitation is open for 14 days. */
export const INVITATION_WINDOW_DAYS = 14;
export const CANDIDATE_REMINDER_DAYS: Readonly<Record<CandidateReminderStage, number>> = { day3: 3, day10: 10 };
/** The recruiter's warning goes when this little of the window is left. */
export const RECRUITER_WARNING_DAYS = 2;
/** A candidate who was just sent the invitation (again) does not need a reminder on top of it. */
const RECENT_SEND_QUIET_MS = 24 * HOUR_MS;
/** Emails per kind per run: a backlog drains over a few runs instead of one long one. */
const SENDS_PER_RUN = 25;
const SCAN_PAGE = 200;
const MAX_SCAN_PAGES = 10;
/** Statuses of an invitation whose link the candidate holds ("created" never reached them). */
const DELIVERED_STATUSES = ['sent', 'opened', 'accepted'];
/** For the recruiter, an undelivered invitation matters too: nobody has the link. */
const OPEN_STATUSES = ['created', ...DELIVERED_STATUSES];

export const REMINDER_JOB = { name: 'invitation-reminders', intervalMs: 15 * 60_000, ttlMs: 10 * 60_000 } as const;
const ACTOR = 'invitation-reminders';

export type ReminderKind = 'candidate_day3' | 'candidate_day10' | 'recruiter_expiry';

/**
 * Which candidate reminder is due now, or null. Counted from the start of the
 * window (expiry minus 14 days), which a resend does not move. Only the latest
 * stage reached is due: a job that was off for a week sends the day-10 note,
 * not both.
 */
export function candidateStageDue(expiresAt: Date, now: Date): CandidateReminderStage | null {
  if (now >= expiresAt) return null;
  const invitedAt = expiresAt.getTime() - INVITATION_WINDOW_DAYS * DAY_MS;
  const day = (now.getTime() - invitedAt) / DAY_MS;
  if (day >= CANDIDATE_REMINDER_DAYS.day10) return 'day10';
  if (day >= CANDIDATE_REMINDER_DAYS.day3) return 'day3';
  return null;
}

export function recruiterWarningDue(expiresAt: Date, now: Date): boolean {
  return now < expiresAt && expiresAt.getTime() - now.getTime() <= RECRUITER_WARNING_DAYS * DAY_MS;
}

/** The singleton ReminderWindow row: one deployment, one moment the switch was thrown. */
const WINDOW_ID = 'reminders';

/**
 * The stamp, written once. Two instances racing both try the insert; the loser
 * reads the winner's value, so every instance works to the same line.
 */
async function stampedActiveFrom(now: Date): Promise<Date> {
  const existing = await prisma.reminderWindow.findUnique({ where: { id: WINDOW_ID }, select: { activeFrom: true } });
  if (existing) return existing.activeFrom;
  try {
    const row = await prisma.reminderWindow.create({ data: { id: WINDOW_ID, activeFrom: now }, select: { activeFrom: true } });
    return row.activeFrom;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'P2002') throw err;
    const won = await prisma.reminderWindow.findUnique({ where: { id: WINDOW_ID }, select: { activeFrom: true } });
    if (!won) throw err;
    return won.activeFrom;
  }
}

/**
 * The line an invitation must have been sent after to be reminded at all.
 *
 * The owner switches reminders on by setting REMINDERS_ENABLED and restarting,
 * and nothing more: the first pass this job makes stamps that moment, and the
 * stamp never moves again. So the day-3 and day-10 notes and the recruiter's
 * warning apply to invitations sent from then on, and the invitations already
 * in flight — some of them weeks old — are left alone for good.
 *
 * REMINDERS_START_AT overrides the stamp when the owner wants to move the line
 * later (back, to pick up a period already passed; forward, to hold off). It
 * does not overwrite the stamp, so removing the variable returns to it rather
 * than to "remind everything".
 */
export async function remindersActiveFrom(now: Date): Promise<Date> {
  const stamped = await stampedActiveFrom(now);
  return config.hrBox.remindersStartAt ?? stamped;
}

/**
 * The invitation's latest send. `sentAt` is null only for one created but never
 * delivered (status "created"), which the candidate's reminders skip anyway and
 * the recruiter's warning does consider; its creation is its closest thing to a
 * send, and using it keeps a row with no `sentAt` out of the reminded set
 * rather than letting a null slip past the comparison.
 */
function latestSend(inv: { sentAt: Date | null; createdAt: Date }): Date {
  return inv.sentAt ?? inv.createdAt;
}

const invitationSelect = {
  id: true, sessionId: true, expiresAt: true, sentAt: true, createdAt: true, openedAt: true, tokenSealed: true,
  session: {
    select: {
      id: true, tenantId: true, candidateId: true, roleId: true, state: true, durationMinutes: true, scheduledTimeZone: true,
      candidate: { select: { fullName: true, email: true } },
      role: { select: { title: true } },
      tenant: { select: { name: true } },
    },
  },
} as const;

type Invitation = NonNullable<Awaited<ReturnType<typeof findInvitationPage>>>[number];

function findInvitationPage(where: object, cursor: { expiresAt: Date; id: string } | null) {
  const after = cursor ? { OR: [{ expiresAt: { gt: cursor.expiresAt } }, { expiresAt: cursor.expiresAt, id: { gt: cursor.id } }] } : {};
  return prisma.invitation.findMany({
    where: { AND: [where, after] },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: SCAN_PAGE,
    select: invitationSelect,
  });
}

interface Due {
  readonly invitation: Invitation;
  readonly expiresAt: Date;
  readonly kind: ReminderKind;
  readonly recipientKey: string;
}

const claimKey = (invitationId: string, cycle: Date, kind: string, recipientKey: string) => `${invitationId}|${cycle.toISOString()}|${kind}|${recipientKey}`;

/**
 * Walk the open invitations in expiry order, a page at a time, and return up
 * to `want` reminders not yet claimed. Paging by a cursor (not a fixed "first
 * N") so invitations already reminded cannot crowd out the ones still due.
 */
async function scanDue(where: object, want: number, pick: (inv: Invitation, expiresAt: Date) => Array<{ kind: ReminderKind; recipientKey: string }> | Promise<Array<{ kind: ReminderKind; recipientKey: string }>>): Promise<Due[]> {
  const found: Due[] = [];
  let cursor: { expiresAt: Date; id: string } | null = null;
  for (let page = 0; page < MAX_SCAN_PAGES && found.length < want; page += 1) {
    const rows = await findInvitationPage(where, cursor);
    if (rows.length === 0) break;
    const last = rows[rows.length - 1];
    cursor = last.expiresAt ? { expiresAt: last.expiresAt, id: last.id } : null;
    const claimed = await prisma.invitationReminder.findMany({
      where: { invitationId: { in: rows.map((r) => r.id) } },
      select: { invitationId: true, cycleExpiresAt: true, kind: true, recipientKey: true },
    });
    const taken = new Set(claimed.map((c) => claimKey(c.invitationId, c.cycleExpiresAt, c.kind, c.recipientKey)));
    for (const inv of rows) {
      if (!inv.expiresAt) continue;
      for (const want of await pick(inv, inv.expiresAt)) {
        if (!taken.has(claimKey(inv.id, inv.expiresAt, want.kind, want.recipientKey))) {
          found.push({ invitation: inv, expiresAt: inv.expiresAt, ...want });
        }
      }
    }
    if (!cursor) break;
  }
  return found.slice(0, want);
}

function baseWhere(now: Date, withinDays: number, statuses: readonly string[], activeFrom: Date) {
  return {
    expiresAt: { gt: now, lte: new Date(now.getTime() + withinDays * DAY_MS) },
    status: { in: [...statuses] },
    // Sent after reminders were switched on. A resend counts: it moves sentAt,
    // and it is a fresh send of a fresh 14-day window, so it earns the
    // reminders of that window even when the first send predates the switch.
    OR: [{ sentAt: { gt: activeFrom } }, { sentAt: null, createdAt: { gt: activeFrom } }],
    session: { state: { in: [...NOT_STARTED_STATES] }, role: { status: { not: 'archived' } }, tenant: { isDemo: false } },
  };
}

/**
 * Why a reminder must not go now, or null when it may. Read after the claim,
 * immediately before the send, and re-checks everything the scan filtered on:
 * the scan is a page read earlier, and any of it may have changed since.
 */
async function ineligibility(due: Due, now: Date, activeFrom: Date): Promise<string | null> {
  const inv = due.invitation;
  const [fresh, decided, asked] = await Promise.all([
    prisma.invitation.findUnique({
      where: { id: inv.id },
      select: {
        expiresAt: true, status: true, sentAt: true, createdAt: true,
        session: { select: { state: true, role: { select: { status: true } }, tenant: { select: { isDemo: true } } } },
      },
    }),
    prisma.candidatePipeline.findFirst({ where: { candidateId: inv.session.candidateId, roleId: inv.session.roleId, status: 'DECIDED' }, select: { id: true } }),
    prisma.candidateHumanRequest.findFirst({ where: { sessionId: inv.sessionId, status: 'REQUESTED' }, select: { id: true } }),
  ]);
  if (!fresh || fresh.expiresAt?.getTime() !== due.expiresAt.getTime() || due.expiresAt <= now) return 'invitation changed or expired';
  if (latestSend(fresh) <= activeFrom) return 'sent before reminders were switched on';
  if (!NOT_STARTED_STATES.includes(fresh.session.state)) return `interview is ${fresh.session.state}`;
  if (fresh.session.role.status === 'archived') return 'role archived';
  if (fresh.session.tenant.isDemo) return 'demo sandbox';
  const toCandidate = due.recipientKey === 'candidate';
  if (!(toCandidate ? DELIVERED_STATUSES : OPEN_STATUSES).includes(fresh.status)) return `invitation is ${fresh.status}`;
  if (decided) return 'application decided';
  if (asked) return 'candidate asked to talk to a person';
  return null;
}

async function resentSince(due: Due, now: Date): Promise<boolean> {
  const fresh = await prisma.invitation.findUnique({ where: { id: due.invitation.id }, select: { sentAt: true } });
  return !!fresh?.sentAt && fresh.sentAt.getTime() > now.getTime() - RECENT_SEND_QUIET_MS;
}

/** Claim, or false when another run (or an earlier one) already has. */
async function claim(due: Due): Promise<string | null> {
  try {
    const row = await prisma.invitationReminder.create({
      data: {
        tenantId: due.invitation.session.tenantId, sessionId: due.invitation.sessionId, invitationId: due.invitation.id,
        cycleExpiresAt: due.expiresAt, kind: due.kind, recipientKey: due.recipientKey,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'P2002') return null;
    throw err;
  }
}

async function finish(id: string, due: Due, outcome: 'sent' | 'failed' | 'skipped', note: string): Promise<void> {
  await prisma.invitationReminder.update({ where: { id }, data: { status: outcome, note: note.slice(0, 200), sentAt: outcome === 'sent' ? new Date() : null } });
  await logAudit({
    tenantId: due.invitation.session.tenantId, actorId: ACTOR, actorType: 'system',
    action: `invitation.reminder_${outcome}`, entityType: 'InterviewSession', entityId: due.invitation.sessionId,
    after: { kind: due.kind, recipient: due.recipientKey === 'candidate' ? 'candidate' : { userId: due.recipientKey }, ...(outcome === 'sent' ? {} : { reason: note }) },
  });
}

async function sendCandidate(due: Due): Promise<void> {
  const { session } = due.invitation;
  const portalUrl = invitationLink(due.invitation);
  if (!portalUrl) throw new Error('invitation link cannot be rebuilt');
  if (await demoRecipientBlocked(session.tenantId, session.candidate.email)) throw new Error('recipient blocked');
  const timeZone = session.scheduledTimeZone ?? await tenantTimeZone(session.tenantId);
  const message = buildCandidateReminder({
    candidateName: session.candidate.fullName, roleTitle: session.role.title, companyName: session.tenant.name,
    portalUrl, durationMinutes: session.durationMinutes, expiresAt: due.expiresAt, timeZone,
    stage: due.kind === 'candidate_day10' ? 'day10' : 'day3',
  });
  await getEmail().send({ ...message, to: session.candidate.email });
}

async function sendRecruiter(due: Due): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: due.recipientKey }, select: { name: true, email: true, tenantId: true } });
  if (!user || user.tenantId !== due.invitation.session.tenantId) throw new Error('recruiter no longer in the organisation');
  const { session } = due.invitation;
  const message = buildRecruiterExpiryWarning({
    recruiterName: user.name, candidateName: session.candidate.fullName, roleTitle: session.role.title,
    expiresAt: due.expiresAt, timeZone: await tenantTimeZone(session.tenantId),
    interviewUrl: `${config.webOrigin.replace(/\/+$/, '')}/interviews/${session.id}`, opened: due.invitation.openedAt !== null,
  });
  await getEmail().send({ ...message, to: user.email });
}

/** The candidate's owners who may resend, else the role's; ids only. */
async function recruitersFor(inv: Invitation): Promise<string[]> {
  const mayResend = (role: string) => capabilitiesOf(role).includes('interview:invite');
  const owners = await prisma.candidateAssignment.findMany({
    where: { candidateId: inv.session.candidateId, relation: 'owner' },
    select: { user: { select: { id: true, role: true, tenantId: true } } },
  });
  const direct = owners.map((o) => o.user).filter((u) => u.tenantId === inv.session.tenantId && mayResend(u.role)).map((u) => u.id);
  if (direct.length > 0) return direct;
  const roleOwners = await prisma.roleAssignment.findMany({
    where: { roleId: inv.session.roleId, relation: 'owner' },
    select: { user: { select: { id: true, role: true, tenantId: true } } },
  });
  return roleOwners.map((o) => o.user).filter((u) => u.tenantId === inv.session.tenantId && mayResend(u.role)).map((u) => u.id);
}

async function deliver(dues: readonly Due[], now: Date, activeFrom: Date, lease: LeaseHandle | null, send: (due: Due) => Promise<void>): Promise<{ sent: number; failed: number; skipped: number; stopped: boolean }> {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const due of dues) {
    if (lease && !(await lease.renew(REMINDER_JOB.ttlMs))) return { sent, failed, skipped, stopped: true };
    // A resend since the scan is a reason to wait, not to give the reminder up:
    // checked before claiming, so a later run can still send it.
    if (due.recipientKey === 'candidate' && await resentSince(due, now)) continue;
    const id = await claim(due);
    if (!id) continue;
    const reason = await ineligibility(due, now, activeFrom);
    if (reason) {
      await finish(id, due, 'skipped', reason);
      skipped += 1;
      continue;
    }
    try {
      await send(due);
      await finish(id, due, 'sent', '');
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ sessionId: due.invitation.sessionId, kind: due.kind, err: message }, 'Invitation reminder not sent');
      await finish(id, due, 'failed', message);
      failed += 1;
    }
  }
  return { sent, failed, skipped, stopped: false };
}

/** One pass. Returns a note for the job record. */
export async function runInvitationReminders(lease: LeaseHandle | null = null, now: Date = new Date()): Promise<string> {
  // Nothing is claimed when mail cannot go: a claim is a promise it was sent.
  // Stamped whether or not anything goes out on this pass: the line is the
  // moment the switch was thrown, not the moment the first email happened to
  // succeed. A pass that cannot mail must not leave the line unset and let a
  // later pass draw it somewhere else.
  const activeFrom = await remindersActiveFrom(now);
  if (!getEmail().delivers) return 'email does not deliver; nothing claimed';
  const quietSince = new Date(now.getTime() - RECENT_SEND_QUIET_MS);
  const candidateWhere = { AND: [baseWhere(now, INVITATION_WINDOW_DAYS - CANDIDATE_REMINDER_DAYS.day3, DELIVERED_STATUSES, activeFrom), { sentAt: { lte: quietSince } }] };
  const candidateDue = await scanDue(candidateWhere, SENDS_PER_RUN, (_inv, expiresAt) => {
    const stage = candidateStageDue(expiresAt, now);
    return stage ? [{ kind: stage === 'day3' ? 'candidate_day3' : 'candidate_day10', recipientKey: 'candidate' }] : [];
  });
  const toCandidates = await deliver(candidateDue, now, activeFrom, lease, sendCandidate);
  if (toCandidates.stopped) return `lease lost after ${toCandidates.sent} candidate reminders`;

  const recruiterDue = await scanDue(baseWhere(now, RECRUITER_WARNING_DAYS, OPEN_STATUSES, activeFrom), SENDS_PER_RUN, async (inv, expiresAt) =>
    recruiterWarningDue(expiresAt, now) ? (await recruitersFor(inv)).map((userId) => ({ kind: 'recruiter_expiry' as const, recipientKey: userId })) : []);
  const toRecruiters = await deliver(recruiterDue, now, activeFrom, lease, sendRecruiter);
  return `candidates: ${toCandidates.sent} sent, ${toCandidates.failed} failed, ${toCandidates.skipped} skipped; recruiters: ${toRecruiters.sent} sent, ${toRecruiters.failed} failed, ${toRecruiters.skipped} skipped`;
}

export function startInvitationReminders(): (() => void) | null {
  if (!config.hrBox.remindersEnabled) return null;
  return startJob({ ...REMINDER_JOB, delayFirst: true, fn: (lease) => runInvitationReminders(lease) });
}
