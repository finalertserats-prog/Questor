import type { InterviewRound } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getEmail, type EmailMessage } from '../providers/email/index.js';
import { companyEmail, escapeHtml, headerSafe } from '../providers/email/branding.js';
import { firstName } from '../engines/openingModel.js';
import { demoRecipientBlocked } from './demoPolicy.js';
import { tenantTimeZone } from './tenantTimeZone.js';
import { candidateClockSentence, formatScheduledTime } from './zonedTime.js';
import { claimRoundCalendar, roundInviteAttachment } from './interviewCalendar.js';
import { calendarDeliveryFor, calendarStateNote, recordCalendarFailure, recordCalendarSent, type CalendarTarget } from './calendarDelivery.js';

/**
 * Telling the candidate about an interview round a person runs.
 *
 * Booking a round used to email only the recruiter who booked it, so the
 * candidate was never told. The AI round goes out as the interview invitation
 * (routes/interviews.ts); this is the note for the human rounds: when, in the
 * zone the round was booked in, and the meeting link when there is one.
 */

/** What the recruiter is told about the candidate's email. */
export interface CandidateNotice {
  readonly sent: boolean;
  readonly note: string;
}

export type RoundNoticeKind = 'booked' | 'moved' | 'link' | 'cancelled';

interface HumanRoundEmail {
  readonly kind: RoundNoticeKind;
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly companyName: string;
  readonly stageLabel: string;
  readonly scheduledAt: Date;
  readonly timeZone: string;
  /**
   * The candidate's own zone, when HR has recorded one. Null leaves the line
   * out altogether rather than restating the booking zone as if it were theirs:
   * a sentence saying "that is 19:30 your time" to someone it is not is worse
   * than no sentence, because it sounds like it was checked.
   */
  readonly candidateTimeZone: string | null;
  readonly durationMinutes: number;
  readonly meetingUrl: string | null;
}

const OPENING: Readonly<Record<Exclude<RoundNoticeKind, 'cancelled'>,(label: string, role: string, when: string) => string>> = {
  booked: (label, role, when) => `Your ${label} interview for the ${role} role is booked for ${when}.`,
  moved: (label, role, when) => `Your ${label} interview for the ${role} role has moved. It is now booked for ${when}.`,
  link: (label, role, when) => `Here is the meeting link for your ${label} interview for the ${role} role, booked for ${when}.`,
};

export function buildHumanRoundEmail(d: HumanRoundEmail): EmailMessage {
  const first = firstName(d.candidateName) || 'there';
  // Configurable labels can hold control characters; strip them before a subject or plain-text body.
  const label = d.stageLabel.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  const when = formatScheduledTime(d.scheduledAt, d.timeZone);
  if (d.kind === 'cancelled') return cancelledEmail(d, first, label, when);
  const theirClock = candidateClockSentence(d.scheduledAt, d.timeZone, d.candidateTimeZone);
  const opening =`${OPENING[d.kind](label, d.roleTitle, when)} It takes about ${d.durationMinutes} minutes.`;
  const join = d.meetingUrl ? `Join the meeting: ${d.meetingUrl}` : 'We will send you the meeting link before then.';
  const text = [
    `Hi ${first},`, '', opening,
    ...(theirClock ? ['', theirClock] : []),
    '', join, '', 'Best regards,', `The ${d.companyName} hiring team`,
  ].join('\n');
  const joinHtml = d.meetingUrl
    ? `<p style="margin:0 0 18px">Join the meeting: <a href="${escapeHtml(d.meetingUrl)}">${escapeHtml(d.meetingUrl)}</a></p>`
    : `<p style="margin:0 0 18px">${escapeHtml(join)}</p>`;
  const html = [
    `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>`,
    `<p style="margin:0 0 18px">${escapeHtml(opening)}</p>`,
    ...(theirClock ? [`<p style="margin:0 0 18px">${escapeHtml(theirClock)}</p>`] : []),
    joinHtml,
    `<p style="margin:0">Best regards,<br>The ${escapeHtml(d.companyName)} hiring team</p>`,
  ].join('\n');
  const subject = d.kind === 'moved'
    ? `Your interview for ${headerSafe(d.roleTitle)} has moved`
    : `Your interview for ${headerSafe(d.roleTitle)} at ${headerSafe(d.companyName)}`;
  return companyEmail({ to: '', subject, text, html }, d.companyName);
}

/** The round is off: no link (the meeting is gone), just what was cancelled. */
function cancelledEmail(d: HumanRoundEmail, first: string, label: string, when: string): EmailMessage {
  const opening = `Your ${label} interview for the ${d.roleTitle} role, booked for ${when}, has been cancelled.`;
  const next = 'The hiring team will be in touch about next steps.';
  const text = [`Hi ${first},`, '', opening, '', next, '', 'Best regards,', `The ${d.companyName} hiring team`].join('\n');
  const html = [
    `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>`,
    `<p style="margin:0 0 18px">${escapeHtml(opening)}</p>`,
    `<p style="margin:0 0 18px">${escapeHtml(next)}</p>`,
    `<p style="margin:0">Best regards,<br>The ${escapeHtml(d.companyName)} hiring team</p>`,
  ].join('\n');
  return companyEmail({ to: '', subject: `Your interview for ${headerSafe(d.roleTitle)} has been cancelled`, text, html }, d.companyName);
}

/**
 * Email the candidate about a human round. Only for a round still ahead: a
 * round recorded after it happened tells the candidate nothing new. Reports
 * honestly whether anything went, as notifyScheduler does.
 */
export async function notifyCandidateOfHumanRound(o: {
  readonly round: InterviewRound;
  readonly candidateId: string;
  readonly roleId: string;
  readonly stageLabel: string;
  /**
   * What prompted this notice — but only as a starting point. A round found
   * CANCELLED below overrides it, for the words and the calendar METHOD alike,
   * because a retry carries the intent it was queued with and the round may
   * have been cancelled since.
   */
  readonly kind: RoundNoticeKind;
  /**
   * The address whose calendar this notice is correcting, when it is not
   * simply the candidate's current one.
   *
   * A CalendarDelivery row is ONE address's copy of an entry. Correcting it
   * means writing to that address: sending to whatever address the candidate
   * has today would leave the copy the row is about untouched, and then record
   * the row as fixed. Only the retry passes this; a first send has no older
   * address to be about.
   */
  readonly deliverTo?: { readonly email: string; readonly name: string };
}): Promise<CandidateNotice> {
  const { round } = o;
  if (round.scheduledAt.getTime() <= Date.now()) {
    return { sent: false, note: 'The round time has passed, so the candidate was not emailed.' };
  }
  const [candidate, role, tenant] = await Promise.all([
    prisma.candidate.findFirst({ where: { id: o.candidateId, tenantId: round.tenantId }, select: { fullName: true, email: true } }),
    prisma.role.findFirst({ where: { id: o.roleId, tenantId: round.tenantId }, select: { title: true } }),
    prisma.tenant.findUnique({ where: { id: round.tenantId }, select: { name: true } }),
  ]);
  if (!candidate?.email || !role) return { sent: false, note: 'The candidate has no email address, so they were not emailed.' };
  // Whose calendar this message is for: the row's address when one is given,
  // the candidate's current one otherwise. The demo block and the send below
  // both test THIS address rather than the candidate record's.
  //
  // The guard above is deliberately still about the candidate record. A
  // candidate with no address at all is someone this product can no longer
  // write to, and a retry for them is closed and reported rather than sent to
  // an address only the delivery row remembers.
  const recipient = o.deliverTo ?? { email: candidate.email, name: candidate.fullName };
  if (await demoRecipientBlocked(round.tenantId, recipient.email)) {
    return { sent: false, note: 'In the demo, email goes only to you, so the candidate was not emailed.' };
  }
  const email = getEmail();
  if (!email.delivers) {
    return { sent: false, note: `Email is not configured to deliver (provider "${email.name}"), so the candidate was not emailed. Tell them yourself.` };
  }
  const companyName = tenant?.name ?? 'our';
  // The sequence number and the row it describes are taken together, and
  // EVERYTHING below is built from the row that comes back — not from the one
  // this function was handed. Two people moving the same round at once would
  // otherwise let a slow request send an older time under a higher sequence,
  // and a higher sequence is what a calendar is told to prefer.
  const claimed = await claimRoundCalendar(round.id);
  const current = claimed.round;
  if (current.scheduledAt.getTime() <= Date.now()) {
    return { sent: false, note: 'The round time has passed, so the candidate was not emailed.' };
  }
  // The intent as the round stands NOW, not as it stood when this was queued.
  //
  // A retry carries the kind it was queued with. If a round was moved, the
  // notice failed, and the round was then cancelled, replaying "moved" would
  // send METHOD:REQUEST for an interview that is not happening — re-adding a
  // meeting to the candidate's calendar with nothing left to correct it. The
  // round's own status is the only thing that can answer this truthfully.
  const kind: RoundNoticeKind = current.status === 'CANCELLED' ? 'cancelled' : o.kind;
  const message = buildHumanRoundEmail({
    kind, candidateName: candidate.fullName, roleTitle: role.title, companyName,
    stageLabel: o.stageLabel, scheduledAt: current.scheduledAt, durationMinutes: current.durationMinutes,
    timeZone: current.scheduledTimeZone ?? await tenantTimeZone(current.tenantId),
    // The round's own snapshot, and nothing else. Reading Candidate.timeZone
    // here would answer "where do they live today" for a round booked before
    // anyone recorded it — re-dating a past interview on the strength of a
    // later profile edit, which is the exact bug the snapshot exists to stop.
    candidateTimeZone: current.candidateTimeZone,
    meetingUrl: current.meetingUrl,
  });
  // The candidate's own copy, naming only them. It may say what the interview
  // is for — it is theirs — which a copy for anyone else may not.
  const invite = roundInviteAttachment(claimed, {
    recipientName: recipient.name, recipientEmail: recipient.email,
    summary: `${companyName}: ${o.stageLabel} interview — ${role.title}`,
    description: message.text,
    location: current.meetingUrl,
    startsAt: current.scheduledAt, durationMinutes: current.durationMinutes,
    method: kind === 'cancelled' ? 'CANCEL' : 'REQUEST',
    organizerName: `${companyName} hiring team`,
  });
  const target: CalendarTarget = { type: 'round', id: round.id, tenantId: round.tenantId };
  try {
    await email.send({ ...message, to: recipient.email, attachments: [invite] });
    // Recorded AFTER the provider accepted it, so the row says what their
    // calendar actually holds rather than what we hoped it would.
    await recordCalendarSent({
      target, recipient, kind, sequence: claimed.sequence, scheduledAt: current.scheduledAt,
    });
    return { sent: true, note: `The candidate was emailed at ${recipient.email}.` };
  } catch (err) {
    const message_ = err instanceof Error ? err.message : String(err);
    logger.error({ err: message_, roundId: round.id }, 'Round email to the candidate failed');
    // The sequence is already spent — it travelled inside the attachment — so
    // their calendar is now behind by a number nobody can reuse. Queued for a
    // rebuild rather than a replay: by the time it runs, the round may have
    // moved again, and the entry that goes out must describe wherever it is
    // then, not wherever it was when this attempt failed.
    await recordCalendarFailure({ target, recipient, kind, error: message_ });
    const behind = calendarStateNote(await calendarDeliveryFor(target, recipient.email));
    return { sent: false, note: `The email to the candidate could not be sent. Tell them yourself.${behind}` };
  }
}
