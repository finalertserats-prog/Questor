import { prisma, parseJsonOptional } from '../db.js';
import { logger } from '../logger.js';
import type { EmailAttachment, EmailMessage } from '../providers/email/index.js';
import { buildCandidateInvite } from '../providers/email/candidateInviteEmail.js';
import { personaNameOf } from '../domain/persona.js';
import { hasObserverNotice } from './observerPolicy.js';
import { orgZone } from './scheduleZone.js';
import type { StatedZoneSource } from './zonedTime.js';
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

/**
 * Who the candidate will meet, and whether anyone else may watch.
 *
 * Read here rather than taken from the caller, because three routes and a
 * retry job compose this letter and none of them selected these columns. The
 * letter has to name the interviewer (the owner's ask, 2026-09-28) and it may
 * only repeat the observer notice when this candidate's own disclosure
 * actually carries it — saying it otherwise would be a disclosure of something
 * that is not true, which is worse than saying nothing.
 */
async function whoIsInTheRoom(sessionId: string): Promise<{ interviewerName: string | null; observerMayWatch: boolean }> {
  const unknown = { interviewerName: null, observerMayWatch: false };
  try {
    const row = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { personaJson: true, consentJson: true } });
    if (!row) return unknown;
    const consent = parseJsonOptional<{ disclosureText?: unknown }>(
      row.consentJson, {}, { model: 'InterviewSession', id: sessionId, field: 'consentJson' },
    );
    const disclosureText = typeof consent.disclosureText === 'string' ? consent.disclosureText : '';
    return {
      interviewerName: personaNameOf(row.personaJson, sessionId),
      observerMayWatch: hasObserverNotice(disclosureText),
    };
  } catch (err) {
    // This read is an improvement to the letter, not a precondition for
    // sending it. A slow replica or a row damaged years ago must not be what
    // stops a candidate hearing about their interview — before this read
    // existed, the invitation went. The disclosure does not degrade to
    // nothing: `interviewerName: null` still renders "an AI interviewer", and
    // the observer notice is shown again on the consent screen and spoken in
    // the opening, so the email is the third place it is said, not the only
    // one.
    logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId }, 'Could not read who is in the room for an invitation; sending without the interviewer’s name');
    return unknown;
  }
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
 * The booked time an invitation states, the zone it states every date in, and
 * — the part that used to be thrown away — where that zone came from.
 *
 * A time already gone is left out: "booked for yesterday" helps nobody. The
 * zone falls back to the organisation's (IST when it has none), never the
 * server's clock. The fallback order was never wrong; what was wrong is that
 * it was silent, so a candidate read a time in somebody else's zone with
 * nothing in the letter to say it was not theirs. `source` is what lets the
 * letter say which of the four it is (services/scheduleZone.ts).
 */
async function inviteTiming(session: { tenantId: string; scheduledAt: Date | null; scheduledTimeZone: string | null; candidateTimeZone: string | null }) {
  const ahead = session.scheduledAt && session.scheduledAt.getTime() > Date.now() ? session.scheduledAt : null;
  if (session.scheduledTimeZone) {
    return { scheduledAt: ahead, timeZone: session.scheduledTimeZone, zoneSource: 'booked' as StatedZoneSource, candidateTimeZone: session.candidateTimeZone };
  }
  const org = await orgZone(session.tenantId);
  return { scheduledAt: ahead, timeZone: org.zone, zoneSource: org.source as StatedZoneSource, candidateTimeZone: session.candidateTimeZone };
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
  const [state, room] = await Promise.all([invitationState(o.session), whoIsInTheRoom(o.session.id)]);
  const message = buildCandidateInvite({
    candidateName: o.candidate.fullName, roleTitle: o.roleTitle, companyName: o.companyName,
    portalUrl: o.portalUrl, durationMinutes: state.durationMinutes, expiresAt: o.expiresAt,
    ...state.timing, ...room,
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
