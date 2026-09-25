import type { EmailAttachment, EmailMessage } from '../providers/email/index.js';
import { companyEmail, emailButton, escapeHtml, headerSafe } from '../providers/email/branding.js';
import { firstName } from '../engines/openingModel.js';
import { candidateClockSentence, formatScheduledTime } from './zonedTime.js';
import { tenantTimeZone } from './tenantTimeZone.js';
import { claimSessionCalendar, sessionInviteAttachment } from './interviewCalendar.js';

/**
 * The invitation a candidate receives for their AI interview, as a message.
 *
 * A service rather than part of routes/interviews.ts because two things now
 * compose this message: the route, which mints the link and moves the
 * interview's state, and the calendar retry job, which needs to rebuild the
 * SAME message from the interview as it stands later. A retry that replayed a
 * stored payload would deliver a time the interview may no longer hold, so the
 * rebuild has to run the real composition again — which means the composition
 * cannot live behind a request.
 */

/** The invitation a candidate receives. It reads as a note from the company's
 *  hiring team: what the next step is, how long it takes, and the link. How the
 *  interview works, including that the interviewer is an AI, is explained on the
 *  page the link opens, before the interview starts and before consent is asked.
 *  Plain-text and HTML bodies are built from the same facts, and the link is
 *  also written out, because some mail clients (Gmail in spam) disable links. */
interface InviteDetails {
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly companyName: string;
  readonly portalUrl: string;
  readonly durationMinutes: number;
  readonly expiresAt: Date | null;
  /** The booked time, when one is set and still ahead. */
  readonly scheduledAt: Date | null;
  /** The zone the email states times in: the booking's, else the organisation's (IST when it has none). */
  readonly timeZone: string;
  /**
   * The candidate's own zone, as at the booking, when HR recorded one. Null
   * leaves the line out: telling somebody a time is "yours" when it is the
   * recruiter's sounds checked, and is not.
   */
  readonly candidateTimeZone: string | null;
}

function inviteDate(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(at);
  return `${day} (${timeZone})`;
}

function buildInvite(d: InviteDetails) {
  const first = firstName(d.candidateName) || 'there';
  const booked = d.scheduledAt ? formatScheduledTime(d.scheduledAt, d.timeZone) : null;
  const intro = booked
    ? `Thank you for applying for the ${d.roleTitle} role at ${d.companyName}. We would like to invite you to the next step: a first-round interview you do online. It is booked for ${booked}, and takes about ${d.durationMinutes} minutes.`
    : `Thank you for applying for the ${d.roleTitle} role at ${d.companyName}. We would like to invite you to the next step: a first-round interview you can do online, whenever it suits you. It takes about ${d.durationMinutes} minutes.`;
  const tips = [
    'Find a quiet spot. A laptop or a phone both work.',
    'Speak or type your answers, whichever you prefer.',
    'If you need any adjustments, you can ask for them when you open the link.',
  ];
  // The portal has no way to book a time, so an unbooked invite offers none.
  const whenToStart = booked
    ? 'Please open the link at that time.'
    : `You can start whenever suits you${d.expiresAt ? ' before then' : ''}.`;
  const until = d.expiresAt ? `The link is open until ${inviteDate(d.expiresAt, d.timeZone)}. ${whenToStart}` : whenToStart;
  // Only where there is a booked time to restate: an invitation the candidate
  // may open whenever suits them has no instant to put on their clock.
  const theirClock = d.scheduledAt ? candidateClockSentence(d.scheduledAt, d.timeZone, d.candidateTimeZone) : null;
  const text = [
    `Hi ${first},`,
    '',
    intro,
    ...(theirClock ? ['', theirClock] : []),
    '',
    `Start your interview: ${d.portalUrl}`,
    '',
    'A few things that help:',
    ...tips.map((tip) => `- ${tip}`),
    '',
    until,
    '',
    'Best regards,',
    `The ${d.companyName} hiring team`,
  ].join('\n');
  const html = [
    `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>`,
    `<p style="margin:0 0 18px">${escapeHtml(intro)}</p>`,
    ...(theirClock ? [`<p style="margin:0 0 18px">${escapeHtml(theirClock)}</p>`] : []),
    emailButton(d.portalUrl, 'Start your interview'),
    '<p style="margin:4px 0 6px;font-weight:600">A few things that help</p>',
    `<ul style="margin:0 0 16px;padding-left:20px">${tips.map((tip) => `<li style="margin:0 0 6px">${escapeHtml(tip)}</li>`).join('')}</ul>`,
    `<p style="margin:0 0 18px;color:#5a5a6e;font-size:14px">${escapeHtml(until)}</p>`,
    `<p style="margin:0">Best regards,<br>The ${escapeHtml(d.companyName)} hiring team</p>`,
  ].join('\n');
  return companyEmail({
    to: '',
    subject: `Your interview for ${headerSafe(d.roleTitle)} at ${headerSafe(d.companyName)}`,
    text,
    html,
  }, d.companyName);
}

/**
 * The state an invitation is about to describe, and the calendar sequence it
 * goes out under — taken together, before a single word is written.
 *
 * The order matters and it is the same order roundCandidateNotice.ts uses.
 * The body used to be built from the session this request read earlier while
 * the attachment was built from the row the claim returned, so one message
 * could name one time in its text and another in its calendar entry. Whatever
 * a person is told, the .ics beside it has to agree — the whole reason the
 * attachment exists is that the reader trusts it to be the same appointment.
 */
async function invitationState(session: {
  readonly id: string;
  readonly tenantId: string;
  readonly scheduledAt: Date | null;
  readonly scheduledTimeZone: string | null;
  readonly candidateTimeZone: string | null;
  readonly durationMinutes: number;
}) {
  // Nothing booked and ahead: no sequence worth spending, and no entry to
  // attach. The body still says "start whenever suits you", from this session.
  if (!session.scheduledAt || session.scheduledAt.getTime() <= Date.now()) {
    return { claimed: null, timing: await inviteTiming(session), durationMinutes: session.durationMinutes };
  }
  const claimed = await claimSessionCalendar(session.id);
  return { claimed, timing: await inviteTiming(claimed.session), durationMinutes: claimed.session.durationMinutes };
}

/**
 * The calendar entry that travels with an invitation, when there is a time to
 * put in a calendar.
 *
 * None for an invitation the candidate may open whenever suits them: an entry
 * with no real start would sit in their calendar claiming an appointment that
 * does not exist. The body still carries everything; this is in addition to it,
 * for the one thing an email cannot do — render the instant on the reader's
 * own clock, wherever they are.
 */
function inviteCalendar(o: {
  readonly state: Awaited<ReturnType<typeof invitationState>>;
  readonly message: EmailMessage;
  readonly candidate: { readonly fullName: string; readonly email: string };
  readonly companyName: string;
  readonly roleTitle: string;
  readonly portalUrl: string;
}): readonly EmailAttachment[] {
  const { claimed, timing, durationMinutes } = o.state;
  // `timing.scheduledAt` is the claimed row's own time, already dropped if it
  // had gone by; the body and the entry therefore cannot disagree.
  if (!claimed || !timing.scheduledAt) return [];
  return [sessionInviteAttachment(claimed, {
    recipientName: o.candidate.fullName, recipientEmail: o.candidate.email,
    // The candidate's own copy, so it may name the company and the role.
    summary: `${o.companyName}: interview — ${o.roleTitle}`,
    description: o.message.text,
    location: o.portalUrl,
    startsAt: timing.scheduledAt, durationMinutes,
    method: 'REQUEST',
    organizerName: `${o.companyName} hiring team`,
  })];
}

/**
 * The booked time an invitation states, and the zone it states every date in.
 * A time already gone is left out: "booked for yesterday" helps nobody. The
 * zone falls back to the organisation's (IST when it has none), never the
 * server's clock.
 */
async function inviteTiming(session: { tenantId: string; scheduledAt: Date | null; scheduledTimeZone: string | null; candidateTimeZone: string | null }) {
  const ahead = session.scheduledAt && session.scheduledAt.getTime() > Date.now() ? session.scheduledAt : null;
  return {
    scheduledAt: ahead,
    timeZone: session.scheduledTimeZone ?? await tenantTimeZone(session.tenantId),
    candidateTimeZone: session.candidateTimeZone,
  };
}

export interface ComposedInvitation {
  readonly message: EmailMessage;
  readonly attachments: readonly EmailAttachment[];
  /**
   * The calendar sequence spent on this message, and the instant it describes.
   * Both null when there was no booked time to put in a calendar — nothing was
   * claimed and nothing is owed.
   */
  readonly sequence: number | null;
  readonly scheduledAt: Date | null;
}

/**
 * One invitation, body and calendar entry together, built from one read of the
 * interview.
 *
 * Claims the calendar sequence first and builds everything from the row that
 * comes back, so the words and the attachment cannot describe different
 * appointments — the same order roundCandidateNotice.ts uses, for the same
 * reason.
 */
export async function composeInvitation(o: {
  readonly session: {
    readonly id: string;
    readonly tenantId: string;
    readonly scheduledAt: Date | null;
    readonly scheduledTimeZone: string | null;
    readonly candidateTimeZone: string | null;
    readonly durationMinutes: number;
  };
  readonly candidate: { readonly fullName: string; readonly email: string };
  readonly roleTitle: string;
  readonly companyName: string;
  readonly portalUrl: string;
  readonly expiresAt: Date | null;
}): Promise<ComposedInvitation> {
  const state = await invitationState(o.session);
  const message = buildInvite({
    candidateName: o.candidate.fullName, roleTitle: o.roleTitle, companyName: o.companyName,
    portalUrl: o.portalUrl, durationMinutes: state.durationMinutes, expiresAt: o.expiresAt, ...state.timing,
  });
  const attachments = inviteCalendar({
    state, message, candidate: o.candidate, companyName: o.companyName, roleTitle: o.roleTitle, portalUrl: o.portalUrl,
  });
  return {
    message,
    attachments,
    sequence: attachments.length > 0 ? state.claimed?.sequence ?? null : null,
    scheduledAt: attachments.length > 0 ? state.timing.scheduledAt : null,
  };
}
