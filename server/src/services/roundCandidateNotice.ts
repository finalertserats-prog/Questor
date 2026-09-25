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
  readonly kind: RoundNoticeKind;
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
  if (await demoRecipientBlocked(round.tenantId, candidate.email)) {
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
  const message = buildHumanRoundEmail({
    kind: o.kind, candidateName: candidate.fullName, roleTitle: role.title, companyName,
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
    recipientName: candidate.fullName, recipientEmail: candidate.email,
    summary: `${companyName}: ${o.stageLabel} interview — ${role.title}`,
    description: message.text,
    location: current.meetingUrl,
    startsAt: current.scheduledAt, durationMinutes: current.durationMinutes,
    method: o.kind === 'cancelled' ? 'CANCEL' : 'REQUEST',
    organizerName: `${companyName} hiring team`,
  });
  try {
    await email.send({ ...message, to: candidate.email, attachments: [invite] });
    return { sent: true, note: `The candidate was emailed at ${candidate.email}.` };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), roundId: round.id }, 'Round email to the candidate failed');
    return { sent: false, note: 'The email to the candidate could not be sent. Tell them yourself.' };
  }
}
