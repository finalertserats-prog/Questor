import type { CalendarDelivery } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * Whether each person's calendar copy of an interview is up to date.
 *
 * WHY THIS EXISTS. The sequence number a calendar update goes out under is
 * inside the .ics attachment, so it has to be spent before the send — you
 * cannot send first and learn the number afterwards. A failed send has
 * therefore already burned its number, and the recipient's calendar is left
 * showing an older time. Until this table nothing recorded that: the recruiter
 * was told "tell them yourself", which is about the email, and the stale
 * calendar entry went unmentioned because nothing knew about it.
 *
 * WHAT IT IS. The third instance of the outbox shape already used twice here —
 * WebhookDelivery and CandidateFeedbackEmail (services/autoFeedback.ts). Claim
 * a row, attempt it, back off, and reap a claim whose worker died. This module
 * owns only the row's lifecycle; it knows nothing about how a message is
 * built, which is what keeps it free of a cycle with the senders.
 *
 * WHAT IT DELIBERATELY DOES NOT HOLD: the message. A retry rebuilds from the
 * interview as it stands at that moment. Replaying a stored payload is the bug
 * this would otherwise introduce — the round may have moved again while the
 * send was failing, and a generic outbox would cheerfully deliver the time
 * nobody holds any more. Only what WAS sent is recorded, and only so that the
 * gap between it and the truth can be seen.
 *
 * WHY RETRIES ARE SAFE HERE, unlike a feedback letter. Same UID, a higher
 * sequence and the same time is a no-op in every calendar client. So there is
 * no equivalent of autoFeedback's SENT_UNVERIFIED caution: the worst a
 * duplicate costs is a second email, never a wrong calendar.
 */

export const CALENDAR_DELIVERY_JOB = {
  name: 'calendar-delivery', intervalMs: 60_000, ttlMs: 5 * 60_000, batch: 20,
} as const;

/** A claim older than this belonged to a worker that is gone. */
export const CALENDAR_SEND_STALE_MS = 10 * 60_000;

/** Give up after this many, and leave the row for a person. */
export const MAX_CALENDAR_ATTEMPTS = 5;

export const CALENDAR_INTERRUPTED_NOTE =
  'The send was interrupted before it finished, so this calendar entry may or may not have been updated.';

export type CalendarTargetType = 'round' | 'interview';

export interface CalendarTarget {
  readonly type: CalendarTargetType;
  readonly id: string;
  readonly tenantId: string;
}

export interface CalendarRecipient {
  readonly email: string;
  readonly name: string;
}

/** 1 min, 5, 25… the same shape of backoff the other two deliveries use. */
function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 5 ** (attempts - 1), 6 * 3_600_000);
}

function key(target: CalendarTarget, recipient: CalendarRecipient) {
  return { targetType_targetId_recipientEmail: { targetType: target.type, targetId: target.id, recipientEmail: recipient.email } };
}

/**
 * This person's calendar now holds this instant, under this sequence.
 *
 * Written after a send the provider accepted. It clears any retry the row was
 * carrying: whatever went wrong last time, their calendar is right now.
 */
export async function recordCalendarSent(o: {
  readonly target: CalendarTarget;
  readonly recipient: CalendarRecipient;
  readonly kind: string;
  readonly sequence: number;
  readonly scheduledAt: Date;
  readonly at?: Date;
}): Promise<void> {
  const sentAt = o.at ?? new Date();
  const sent = {
    status: 'SENT', kind: o.kind, sentAt, sequenceSent: o.sequence, scheduledAtSent: o.scheduledAt,
    attempts: 0, nextAttemptAt: null, claimedAt: null, lastError: '',
  };
  await prisma.calendarDelivery.upsert({
    where: key(o.target, o.recipient),
    create: {
      tenantId: o.target.tenantId, targetType: o.target.type, targetId: o.target.id,
      recipientEmail: o.recipient.email, recipientName: o.recipient.name, ...sent,
    },
    update: { ...sent, recipientName: o.recipient.name },
  });
}

/**
 * The send did not happen, so this person's calendar is now behind.
 *
 * Queued for the job to rebuild and try again — not to replay this attempt.
 * The row records only that something is owed, never what was owed, because
 * what is owed is whatever the interview says next time anyone looks.
 */
export async function recordCalendarFailure(o: {
  readonly target: CalendarTarget;
  readonly recipient: CalendarRecipient;
  readonly kind: string;
  readonly error: string;
  readonly at?: Date;
}): Promise<void> {
  const now = o.at ?? new Date();
  const existing = await prisma.calendarDelivery.findUnique({ where: key(o.target, o.recipient), select: { attempts: true } });
  const attempts = (existing?.attempts ?? 0) + 1;
  const giveUp = attempts >= MAX_CALENDAR_ATTEMPTS;
  const failed = {
    status: giveUp ? 'FAILED' : 'QUEUED',
    kind: o.kind,
    attempts,
    nextAttemptAt: giveUp ? null : new Date(now.getTime() + retryDelayMs(attempts)),
    claimedAt: null,
    lastError: o.error.slice(0, 500),
  };
  await prisma.calendarDelivery.upsert({
    where: key(o.target, o.recipient),
    create: {
      tenantId: o.target.tenantId, targetType: o.target.type, targetId: o.target.id,
      recipientEmail: o.recipient.email, recipientName: o.recipient.name, ...failed,
    },
    update: { ...failed, recipientName: o.recipient.name },
  });
  if (giveUp) {
    logger.error(
      { targetType: o.target.type, targetId: o.target.id, attempts },
      'A calendar entry could not be delivered after every retry; the recipient’s calendar is out of date',
    );
  }
}

/**
 * Nothing more is owed on this entry, and no retry should chase it: the
 * interview is over, cancelled, or the recipient is no longer on it.
 */
export async function closeCalendarDelivery(target: CalendarTarget, recipient: CalendarRecipient, reason: string): Promise<void> {
  await prisma.calendarDelivery.updateMany({
    where: { targetType: target.type, targetId: target.id, recipientEmail: recipient.email, status: { in: ['QUEUED', 'SENDING'] } },
    data: { status: 'FAILED', nextAttemptAt: null, claimedAt: null, lastError: reason.slice(0, 500) },
  });
}

/**
 * Take a due row for this worker, or find that somebody else has it. Conditional
 * on the status AND the due time, so two instances draining at once cannot both
 * win the same row.
 */
export async function claimCalendarDelivery(id: string, now: Date): Promise<CalendarDelivery | null> {
  const { count } = await prisma.calendarDelivery.updateMany({
    where: { id, status: 'QUEUED', nextAttemptAt: { lte: now } },
    data: { status: 'SENDING', claimedAt: now },
  });
  if (count !== 1) return null;
  return prisma.calendarDelivery.findUnique({ where: { id } });
}

/** Rows due for another attempt, oldest first. */
export async function dueCalendarDeliveries(now: Date, take: number): Promise<{ id: string }[]> {
  return prisma.calendarDelivery.findMany({
    where: { status: 'QUEUED', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take,
    select: { id: true },
  });
}

/**
 * Put back a claim whose worker died. Queued rather than failed, unlike the
 * feedback letter's equivalent: an interrupted calendar update is safe to try
 * again, because a repeat of one is a no-op on the reader's calendar.
 */
export async function releaseInterruptedCalendarSends(now: Date): Promise<number> {
  const stale = await prisma.calendarDelivery.findMany({
    where: { status: 'SENDING', claimedAt: { lt: new Date(now.getTime() - CALENDAR_SEND_STALE_MS) } },
    select: { id: true, claimedAt: true },
  });
  let released = 0;
  for (const row of stale) {
    const { count } = await prisma.calendarDelivery.updateMany({
      where: { id: row.id, status: 'SENDING', claimedAt: row.claimedAt },
      data: { status: 'QUEUED', nextAttemptAt: now, claimedAt: null, lastError: CALENDAR_INTERRUPTED_NOTE },
    });
    released += count;
  }
  return released;
}

/**
 * What a recipient's calendar currently shows for this interview, when that is
 * not what the interview says.
 *
 * Null when their copy is right, or when nothing has ever been sent to them.
 * This is the answer to "nothing knows the calendar is stale" — it is a plain
 * query, so it can be shown to a recruiter, counted, and alerted on.
 */
export function calendarIsBehind(row: Pick<CalendarDelivery, 'status' | 'scheduledAtSent'>, scheduledAt: Date | null): boolean {
  if (row.status === 'QUEUED' || row.status === 'SENDING' || row.status === 'FAILED') return true;
  if (!row.scheduledAtSent || !scheduledAt) return false;
  return row.scheduledAtSent.getTime() !== scheduledAt.getTime();
}

export interface StaleCalendarEntry {
  readonly delivery: CalendarDelivery;
  /** The instant the interview actually holds, or null if it no longer holds one. */
  readonly scheduledAt: Date | null;
}

/**
 * Every recipient whose calendar is out of step with the interview it belongs
 * to. Tenant-scoped where a tenant is given, so it can back a page as well as
 * an operator alert.
 */
export async function staleCalendarEntries(o: { readonly tenantId?: string; readonly take?: number } = {}): Promise<StaleCalendarEntry[]> {
  const rows = await prisma.calendarDelivery.findMany({
    where: {
      ...(o.tenantId ? { tenantId: o.tenantId } : {}),
      OR: [{ status: 'QUEUED' }, { status: 'SENDING' }, { status: 'FAILED' }, { status: 'SENT' }],
    },
    orderBy: { updatedAt: 'desc' },
    take: o.take ?? 200,
  });
  const out: StaleCalendarEntry[] = [];
  for (const delivery of rows) {
    const scheduledAt = delivery.targetType === 'round'
      ? (await prisma.interviewRound.findUnique({ where: { id: delivery.targetId }, select: { scheduledAt: true } }))?.scheduledAt ?? null
      : (await prisma.interviewSession.findUnique({ where: { id: delivery.targetId }, select: { scheduledAt: true } }))?.scheduledAt ?? null;
    if (calendarIsBehind(delivery, scheduledAt)) out.push({ delivery, scheduledAt });
  }
  return out;
}

/**
 * What to add to "tell them yourself" so the recruiter knows what the person's
 * calendar is actually showing. Empty when there is nothing extra to say.
 */
export function calendarStateNote(row: Pick<CalendarDelivery, 'status' | 'scheduledAtSent'> | null): string {
  if (!row || !row.scheduledAtSent) return ' Nothing has reached their calendar for this interview yet.';
  if (row.status === 'SENT') return '';
  return ` Their calendar still shows ${row.scheduledAtSent.toISOString()} — it will be corrected automatically, or you can tell them.`;
}

/** This recipient's delivery row, for the two notes above. */
export async function calendarDeliveryFor(target: CalendarTarget, recipientEmail: string): Promise<CalendarDelivery | null> {
  return prisma.calendarDelivery.findUnique({
    where: { targetType_targetId_recipientEmail: { targetType: target.type, targetId: target.id, recipientEmail } },
  });
}
