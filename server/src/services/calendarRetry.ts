import type { CalendarDelivery } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getEmail } from '../providers/email/index.js';
import { parseStages } from '../domain/pipelineStages.js';
import { alertOperator, startJob } from './jobs.js';
import { demoRecipientBlocked } from './demoPolicy.js';
import { invitationLink } from './invitations.js';
import { composeInvitation } from './interviewInvite.js';
import { notifyCandidateOfHumanRound, type RoundNoticeKind } from './roundCandidateNotice.js';
import {
  CALENDAR_DELIVERY_JOB, calendarIsBehind, claimCalendarDelivery, closeCalendarDelivery,
  dueCalendarDeliveries, recordCalendarFailure, recordCalendarSent, releaseInterruptedCalendarSends,
  staleCalendarEntries, type CalendarTarget,
} from './calendarDelivery.js';

/**
 * Putting right the calendar entries a failed send left behind.
 *
 * REBUILT, NEVER REPLAYED. Each attempt reads the interview as it stands right
 * now and composes the message from that. A queue that stored the message and
 * re-posted it would be worse than no queue at all: the round may have moved
 * again while the send was failing, and the stored copy would faithfully
 * deliver a time nobody holds. The row says only that something is owed; what
 * is owed is whatever the interview says at the moment anyone looks.
 *
 * Duplicates are safe here, which is what makes retrying at all reasonable:
 * the same UID under a higher sequence with the same time is a no-op in every
 * calendar client. The worst a repeat costs is a second email.
 *
 * Kept apart from calendarDelivery.ts, which owns the row lifecycle and knows
 * nothing about messages — that separation is what stops this and the senders
 * importing each other in a circle.
 */

/** A row that cannot be delivered now and should stop asking. */
async function giveUp(row: CalendarDelivery, reason: string): Promise<void> {
  await closeCalendarDelivery(
    { type: row.targetType as 'round' | 'interview', id: row.targetId, tenantId: row.tenantId },
    { email: row.recipientEmail, name: row.recipientName },
    reason,
  );
}

/**
 * A round's entry, rebuilt through the very function that sends it in the
 * first place — so a retry cannot drift from a first attempt. That function
 * re-reads the round, claims a fresh sequence and records the outcome on this
 * row itself, which is why nothing is recorded here.
 */
async function retryRound(row: CalendarDelivery): Promise<'sent' | 'closed' | 'retry'> {
  const round = await prisma.interviewRound.findUnique({ where: { id: row.targetId } });
  if (!round) { await giveUp(row, 'The round no longer exists.'); return 'closed'; }
  const pipeline = await prisma.candidatePipeline.findUnique({
    where: { id: round.pipelineId }, select: { candidateId: true, roleId: true, stagesJson: true },
  });
  if (!pipeline) { await giveUp(row, 'The pipeline this round belonged to no longer exists.'); return 'closed'; }
  const stageLabel = parseStages(pipeline.stagesJson).find((stage) => stage.key === round.stageKey)?.label ?? round.stageKey;
  const notice = await notifyCandidateOfHumanRound({
    round,
    candidateId: pipeline.candidateId,
    roleId: pipeline.roleId,
    stageLabel,
    // Whatever the last intent was. The METHOD the entry carries is read from
    // the round's own status inside, not from this.
    kind: (row.kind as RoundNoticeKind) || 'moved',
  });
  if (notice.sent) return 'sent';
  // notifyCandidateOfHumanRound records a send it attempted and lost. If the
  // row is untouched, it never got that far — a round in the past, a candidate
  // with no address, a provider that does not deliver — and none of those are
  // improved by asking again.
  const after = await prisma.calendarDelivery.findUnique({ where: { id: row.id }, select: { status: true } });
  if (after?.status === 'SENDING') { await giveUp(row, notice.note); return 'closed'; }
  return 'retry';
}

/** An AI interview's entry, rebuilt from the interview and its live invitation. */
async function retryInterview(row: CalendarDelivery): Promise<'sent' | 'closed' | 'retry'> {
  const target: CalendarTarget = { type: 'interview', id: row.targetId, tenantId: row.tenantId };
  const recipient = { email: row.recipientEmail, name: row.recipientName };
  const session = await prisma.interviewSession.findUnique({ where: { id: row.targetId } });
  if (!session) { await giveUp(row, 'The interview no longer exists.'); return 'closed'; }
  if (!session.scheduledAt || session.scheduledAt.getTime() <= Date.now()) {
    await giveUp(row, 'The interview time has passed, so there is nothing to correct.');
    return 'closed';
  }
  const [candidate, role, tenant, invitation] = await Promise.all([
    prisma.candidate.findFirst({ where: { id: session.candidateId, tenantId: session.tenantId }, select: { fullName: true, email: true } }),
    prisma.role.findFirst({ where: { id: session.roleId, tenantId: session.tenantId }, select: { title: true } }),
    prisma.tenant.findUnique({ where: { id: session.tenantId }, select: { name: true } }),
    prisma.invitation.findUnique({ where: { sessionId: session.id } }),
  ]);
  if (!candidate?.email || !role) { await giveUp(row, 'The candidate has no email address.'); return 'closed'; }
  if (!invitation) { await giveUp(row, 'This interview has no invitation to resend.'); return 'closed'; }
  if (invitation.expiresAt && invitation.expiresAt < new Date()) { await giveUp(row, 'The invitation has expired.'); return 'closed'; }
  const portalUrl = invitationLink(invitation);
  if (!portalUrl) { await giveUp(row, 'The invitation link can no longer be rebuilt.'); return 'closed'; }
  if (await demoRecipientBlocked(session.tenantId, candidate.email)) {
    await giveUp(row, 'In the demo, email goes only to the sandbox owner.');
    return 'closed';
  }
  const email = getEmail();
  if (!email.delivers) { await giveUp(row, `Email is not configured to deliver (provider "${email.name}").`); return 'closed'; }

  const composed = await composeInvitation({
    session, candidate, roleTitle: role.title, companyName: tenant?.name ?? 'our', portalUrl, expiresAt: invitation.expiresAt,
  });
  if (composed.sequence === null || !composed.scheduledAt) {
    await giveUp(row, 'The interview no longer has a time to put in a calendar.');
    return 'closed';
  }
  try {
    await email.send({ ...composed.message, to: candidate.email, attachments: composed.attachments });
  } catch (err) {
    await recordCalendarFailure({ target, recipient, kind: 'invited', error: err instanceof Error ? err.message : String(err) });
    return 'retry';
  }
  await recordCalendarSent({
    target, recipient, kind: 'invited', sequence: composed.sequence, scheduledAt: composed.scheduledAt,
  });
  return 'sent';
}

/** One attempt at one entry. Does nothing unless it wins the claim. */
export async function attemptCalendarDelivery(id: string, now = new Date()): Promise<'sent' | 'closed' | 'retry' | 'not-due'> {
  const row = await claimCalendarDelivery(id, now);
  if (!row) return 'not-due';
  try {
    return row.targetType === 'round' ? await retryRound(row) : await retryInterview(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ calendarDeliveryId: id, err: message }, 'A calendar entry could not be rebuilt');
    await recordCalendarFailure({
      target: { type: row.targetType as 'round' | 'interview', id: row.targetId, tenantId: row.tenantId },
      recipient: { email: row.recipientEmail, name: row.recipientName },
      kind: row.kind, error: message,
    });
    return 'retry';
  }
}

/**
 * Tell the operator when entries have stopped trying. Rate-limited to once an
 * hour per job by alertOperator, so a bad afternoon is one message.
 */
async function alertOnAbandoned(): Promise<number> {
  const stale = await staleCalendarEntries({ take: 200 });
  const abandoned = stale.filter((s) => s.delivery.status === 'FAILED');
  if (abandoned.length === 0) return 0;
  await alertOperator(
    CALENDAR_DELIVERY_JOB.name,
    `${abandoned.length} interview calendar ${abandoned.length === 1 ? 'entry is' : 'entries are'} out of date and no longer being retried. `
    + 'The people holding them are seeing an interview time that has changed.',
  );
  return abandoned.length;
}

/** Everything due, for the background job. Returns the note for the job run. */
export async function deliverDueCalendarEntries(now = new Date()): Promise<string> {
  const interrupted = await releaseInterruptedCalendarSends(now);
  const due = await dueCalendarDeliveries(now, CALENDAR_DELIVERY_JOB.batch);
  const tally = { sent: 0, closed: 0, retry: 0, 'not-due': 0 };
  for (const row of due) tally[await attemptCalendarDelivery(row.id, now)] += 1;
  const abandoned = await alertOnAbandoned();
  return `${due.length} due: ${tally.sent} corrected, ${tally.closed} closed, ${tally.retry} retrying; `
    + `${interrupted} interrupted, ${abandoned} abandoned`;
}

export function startCalendarDelivery(intervalMs: number = CALENDAR_DELIVERY_JOB.intervalMs): () => void {
  return startJob({
    name: CALENDAR_DELIVERY_JOB.name, intervalMs, ttlMs: CALENDAR_DELIVERY_JOB.ttlMs,
    fn: () => deliverDueCalendarEntries(),
  });
}

/** Re-exported so a caller needs one import to ask "is anybody's calendar wrong?". */
export { calendarIsBehind, staleCalendarEntries };
