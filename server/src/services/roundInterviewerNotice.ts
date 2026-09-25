import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getEmail, type EmailMessage } from '../providers/email/index.js';
import { brandedEmail, escapeHtml, headerSafe } from '../providers/email/branding.js';
import { capabilitiesOf } from '../domain/capabilities.js';
import { SME_RELATION } from './access.js';
import { tenantTimeZone } from './tenantTimeZone.js';
import { formatScheduledTime } from './zonedTime.js';

/**
 * Telling the people seated on a round about the round they are conducting.
 *
 * Booking a round emailed one person: whoever pressed the button. The seats
 * written in the same transaction (RoundInterviewer) reached no channel at all
 * — not email, not the "Needs you" queue — so an expert booked to conduct a
 * Gold round learned about it only if a colleague told them out of band.
 *
 * This is a different letter from the booker's confirmation, not a copy of it.
 * The booker is told their booking landed; the person seated is told what the
 * seat asks of them, which is news.
 *
 * The trigger is somebody becoming SEATED, not a round being booked. The two
 * are the same event today — seats are only ever written when the round is
 * created (routes/pipelines.ts) — but they are not the same thing, and the
 * owner's rule is that a seat can be added to a round that has already
 * happened. So what the letter says is derived from the round's own state
 * rather than from which route called (see `seatedKind`), and a second seating
 * path would need no new wording.
 *
 * Three rules shape everything below.
 *
 * An email cannot be recalled. So every later change to the round sends too,
 * and a move names the time the round WAS as well as the time it now is —
 * an interviewer holding a time nobody has contradicted will turn up at it.
 * And a send that was built against a schedule the round no longer has is
 * refused rather than sent: misinforming is worse than staying quiet.
 *
 * The letter carries no candidate. Not their name, and certainly not their
 * address: it lands in an inbox Questor does not control, and a seated expert
 * is not entitled to the candidate's contact details on any surface. Who the
 * candidate is travels in the link, behind the reader's own sign-in.
 */

/**
 * What a letter is about.
 *
 * `seated` is the one the caller asks for when somebody becomes seated on a
 * round; which of three things it actually says is the round's business, not
 * the caller's — see `seatedKind`. The rest are the round changing under a
 * seat that already exists.
 */
export type InterviewerNoticeKind = 'seated' | 'moved' | 'link' | 'cancelled';

/**
 * The three things being seated can mean, decided by the round rather than by
 * the route that seated them. The owner's rule (2026-09-25): a seat is not
 * always a summons.
 *
 * - `conducting` — a human round still ahead. They run it; they need the time
 *   and the link.
 * - `observing` — an AI round. The AI conducts it and a human observer is
 *   OPTIONAL, so the letter invites rather than instructs. What the observer
 *   owes is the review afterwards, not attendance.
 * - `reviewing` — a round already over. An expert can be brought in after the
 *   fact to read the recording and say what they think, so "you are booked to
 *   interview" would be false; the ask is to review.
 */
type SeatedKind = 'conducting' | 'observing' | 'reviewing';

function seatedKind(o: { readonly scheduledAt: Date; readonly aiRound: boolean }, now: number): SeatedKind {
  if (o.scheduledAt.getTime() <= now) return 'reviewing';
  return o.aiRound ? 'observing' : 'conducting';
}

/** What the person who changed the round is told about each interviewer's email. */
export interface InterviewerNotice {
  readonly userId: string;
  readonly delivered: boolean;
  readonly note: string;
}

interface InterviewerEmail {
  readonly kind: InterviewerNoticeKind;
  readonly stageLabel: string;
  readonly scheduledAt: Date;
  readonly timeZone: string;
  readonly durationMinutes: number;
  readonly meetingUrl: string | null;
  /** The page this reader's role can actually open, or null when their role can open none. */
  readonly link: string | null;
  /** For a move: the time they were last told, already formatted. */
  readonly previousWhen: string | null;
  readonly aiRound: boolean;
  /** Only read for `seated`; the round decides it (see `seatedKind`). */
  readonly seated?: SeatedKind;
}

const SEATED_OPENING: Readonly<Record<SeatedKind, (label: string, when: string, minutes: number) => string>> = {
  conducting: (label, when, minutes) =>
    `You are down to conduct the ${label} interview, booked for ${when}. It runs for about ${minutes} minutes.`,
  // An invitation, not a summons: joining is the observer's own call, and what
  // they owe is the review afterwards either way. Wording this as an
  // instruction would make a Silver AI interview look like a mandatory shift.
  observing: (label, when) =>
    `You have been asked to observe the ${label} AI interview, booked for ${when}. The AI conducts it and joining is up to you — either way, please give your assessment once it is done.`,
  reviewing: (label, when) =>
    `You have been asked to assess the ${label} interview, which took place on ${when}. The recording and transcript are waiting for you; your read goes to the hiring team, who take the decision.`,
};

function opening(d: InterviewerEmail, label: string, when: string): string {
  if (d.kind === 'cancelled') {
    return `The ${label} interview you were down to conduct, booked for ${when}, has been cancelled. Nothing is needed from you.`;
  }
  if (d.kind === 'moved') {
    const was = d.previousWhen ? ` It was booked for ${d.previousWhen}.` : '';
    return `The ${label} interview you are conducting has moved. It is now booked for ${when}.${was}`;
  }
  if (d.kind === 'link') {
    return `Here is the meeting link for the ${label} interview you are conducting, booked for ${when}.`;
  }
  return SEATED_OPENING[d.seated ?? 'conducting'](label, when, d.durationMinutes);
}

const SEATED_SUBJECT: Readonly<Record<SeatedKind, (label: string) => string>> = {
  conducting: (label) => `You are conducting the ${label} interview`,
  observing: (label) => `You are invited to observe the ${label} AI interview`,
  reviewing: (label) => `Your assessment is asked for on the ${label} interview`,
};

function subject(d: InterviewerEmail, label: string): string {
  switch (d.kind) {
    case 'moved': return `The ${label} interview you are conducting has moved`;
    case 'cancelled': return `The ${label} interview is cancelled`;
    case 'link': return `Meeting link for the ${label} interview`;
    case 'seated': return SEATED_SUBJECT[d.seated ?? 'conducting'](label);
  }
}

export function buildRoundInterviewerEmail(d: InterviewerEmail): EmailMessage {
  // Stage labels are configurable, so control characters are stripped before
  // they reach a subject line or a plain-text body, where a line break could
  // forge headers. HTML escaping below does not cover these.
  const label = d.stageLabel.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  const when = formatScheduledTime(d.scheduledAt, d.timeZone);
  const intro = opening(d, label, when);
  // A cancelled round's meeting no longer exists, and a round already over has
  // nothing left to join, so neither repeats the link.
  const over = d.kind === 'cancelled' || d.seated === 'reviewing';
  const meetingUrl = over ? null : d.meetingUrl;
  const pageLead = d.seated === 'reviewing' ? 'Everything you need is here:' : 'Everything you need to prepare is here:';

  const lines = [intro];
  if (meetingUrl) lines.push(`Join the meeting: ${meetingUrl}`);
  if (d.link) lines.push(`${pageLead}\n${d.link}`);

  const htmlLines = [`<p>${escapeHtml(intro)}</p>`];
  if (meetingUrl) htmlLines.push(`<p>Join the meeting: <a href="${escapeHtml(meetingUrl)}">${escapeHtml(meetingUrl)}</a></p>`);
  if (d.link) htmlLines.push(`<p>${escapeHtml(pageLead.replace(/:$/, ''))} <a href="${escapeHtml(d.link)}">here</a>.</p>`);

  return brandedEmail({
    to: '',
    subject: headerSafe(subject(d, label)),
    text: lines.join('\n\n'),
    html: htmlLines.join('\n'),
  });
}

/**
 * The page a seated person's own role can open for this candidate.
 *
 * Not one link for everybody. A colleague who works in candidate scope reaches
 * /candidates/:id; an expert holds none of the capabilities that page is gated
 * on and reaches the candidate only through /api/sme — and only for a candidate
 * they were ASSIGNED, which a round seat does not grant (routes/pipelines.ts
 * says so in as many words). So an expert who has not also been assigned has no
 * candidate page at all, and is sent to their own worklist rather than to a 404
 * they would read as a broken product.
 */
function linkFor(role: string, candidateId: string, smeAssigned: boolean): string | null {
  const capabilities = capabilitiesOf(role);
  if (capabilities.includes('candidate:read')) return `${config.webOrigin}/candidates/${candidateId}`;
  if (!capabilities.includes('sme:assigned_read')) return null;
  return smeAssigned ? `${config.webOrigin}/sme/candidates/${candidateId}` : `${config.webOrigin}/sme`;
}

export interface NotifyInterviewersInput {
  readonly roundId: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly stageLabel: string;
  readonly kind: InterviewerNoticeKind;
  /**
   * The start time the caller acted on. The round is read again here, and a
   * round whose schedule has moved since is left to the reschedule's own
   * letter: booking and immediately rescheduling would otherwise race, and the
   * loser would announce a time that is already wrong.
   */
  readonly expectScheduledAt: Date;
  /** The time the seats were last told, for a move. */
  readonly previousScheduledAt?: Date | null;
  readonly previousTimeZone?: string | null;
  /** Skipped because they are getting the booker's own letter for the same click. */
  readonly skipUserId?: string | null;
}

/**
 * Email everyone seated on a round. Never throws: the round is already
 * committed by the time this runs, and a booking that 500s because an SMTP
 * server was slow is a worse outcome than a letter that did not go.
 */
export async function notifyRoundInterviewers(o: NotifyInterviewersInput): Promise<InterviewerNotice[]> {
  try {
    return await sendAll(o);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), roundId: o.roundId }, 'Round emails to the interviewers failed');
    return [];
  }
}

async function sendAll(o: NotifyInterviewersInput): Promise<InterviewerNotice[]> {
  const round = await prisma.interviewRound.findFirst({
    where: { id: o.roundId, tenantId: o.tenantId },
    select: {
      scheduledAt: true, scheduledTimeZone: true, durationMinutes: true, meetingUrl: true,
      conductedBy: true, sessionId: true,
      // The seat's user is read through the relation so a seat whose account
      // has gone takes itself out of the list rather than being emailed into
      // the void — there is no deactivated flag on User to consult, so
      // existence is the only signal there is.
      panel: {
        orderBy: { createdAt: 'asc' as const },
        select: { userId: true, user: { select: { id: true, tenantId: true, email: true, role: true } } },
      },
    },
  });
  if (!round) return [];
  // A round nobody has moved since the caller read it. Compared on the
  // instant, which is what an interviewer would turn up at.
  if (round.scheduledAt.getTime() !== o.expectScheduledAt.getTime()) return [];
  // Being seated on a round that is already over is a real ask — HR brings an
  // expert in afterwards to read the recording — so `seated` still sends. A
  // round in the past cannot usefully move, gain a link or be called off,
  // though, so those stay quiet rather than emailing about a time that has been
  // and gone.
  const aiRound = round.conductedBy === 'AI' && round.sessionId !== null;
  const seated = seatedKind({ scheduledAt: round.scheduledAt, aiRound }, Date.now());
  if (o.kind !== 'seated' && seated === 'reviewing') return [];

  const seats = round.panel.filter((seat) => (
    seat.user !== null && seat.user.tenantId === o.tenantId && seat.user.email.trim().length > 0 && seat.userId !== o.skipUserId
  ));
  if (seats.length === 0) return [];

  const email = getEmail();
  if (!email.delivers) {
    const note = `Email is not configured to deliver (provider "${email.name}"), so the interviewers were not emailed. Tell them yourself.`;
    return seats.map((seat) => ({ userId: seat.userId, delivered: false, note }));
  }

  const timeZone = round.scheduledTimeZone ?? await tenantTimeZone(o.tenantId);
  const previousWhen = o.previousScheduledAt
    ? formatScheduledTime(o.previousScheduledAt, o.previousTimeZone ?? timeZone)
    : null;
  const assigned = new Set((await prisma.candidateAssignment.findMany({
    where: { candidateId: o.candidateId, relation: SME_RELATION, userId: { in: seats.map((s) => s.userId) } },
    select: { userId: true },
  })).map((row) => row.userId));

  // One failing address must not silence the others: each send stands alone,
  // and they go together rather than one after the next.
  return Promise.all(seats.map(async (seat): Promise<InterviewerNotice> => {
    const message = buildRoundInterviewerEmail({
      kind: o.kind, stageLabel: o.stageLabel, scheduledAt: round.scheduledAt, timeZone, seated,
      durationMinutes: round.durationMinutes, meetingUrl: round.meetingUrl, previousWhen, aiRound,
      link: linkFor(seat.user!.role, o.candidateId, assigned.has(seat.userId)),
    });
    try {
      await email.send({ ...message, to: seat.user!.email });
      return { userId: seat.userId, delivered: true, note: `Sent to ${seat.user!.email}.` };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), roundId: o.roundId }, 'Round email to an interviewer failed');
      return { userId: seat.userId, delivered: false, note: `The email to ${seat.user!.email} could not be sent. Tell them yourself.` };
    }
  }));
}
