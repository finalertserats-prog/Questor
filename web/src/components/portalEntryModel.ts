/**
 * Which screen an invitation link opens on, decided from the session's state.
 * Kept free of React so every state can be unit tested (see
 * web/tests/portalEntryModel.test.ts).
 *
 * WHY this exists: the portal used to ignore the state entirely and always
 * opened on the consent journey. A candidate who came back to their link
 * mid-interview — a closed tab, a dropped connection — was asked to consent
 * again, and pressing the button produced "This interview has already started
 * or finished", which reads as the interview being lost. The server is right to
 * refuse; the page was wrong to ask.
 *
 * The state names mirror server/src/domain/stateMachine.ts. They are never
 * shown: to the person reading this page an internal state name reads as a
 * crash, and several of them (NO_SHOW, CANDIDATE_WITHDREW) read as a verdict.
 */

export type PortalEntry =
  /** Before the interview: review → consent → audio check. */
  | { readonly kind: 'journey' }
  /** Consent is on record and the room can be entered. */
  | { readonly kind: 'rejoin'; readonly title: string; readonly message: string; readonly action: string }
  /** The candidate's part is done; nothing more to do here. */
  | { readonly kind: 'finished'; readonly title: string; readonly message: string }
  /** The interview is not open, for a reason the candidate is told plainly. */
  | { readonly kind: 'closed'; readonly title: string; readonly message: string };

/**
 * The server's PRE_INTERVIEW_STATES (routes/portal.ts): the only states in
 * which consent and the audio check are accepted. Offering the journey in any
 * other state is offering a form the server will refuse.
 */
const JOURNEY_STATES: readonly string[] = ['PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'DISCLOSURE', 'CONSENTED'];

/**
 * The engine's LIVE_STATES (realtime/interviewEngine.ts). Starting again here
 * resumes the conversation already on record rather than beginning a new one.
 */
const IN_PROGRESS_STATES: readonly string[] = ['ASSESSING', 'CANDIDATE_QUESTIONS'];

/**
 * Startable in the engine (STARTABLE_STATES) but past the point where the
 * portal takes consent, so the only useful thing left is to enter the room —
 * and only when consent is on record, because the engine refuses to start
 * without it and would send the candidate straight back here. Nothing in the
 * current code writes these; they are handled so a session that reaches one is
 * not stranded on a refused form.
 */
const READY_STATES: readonly string[] = ['WAITING', 'CONNECTING', 'WARMUP'];

/** The candidate has finished; scoring and review happen without them. */
const FINISHED_STATES: readonly string[] = ['CLOSING', 'PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED'];

export const FINISHED_ENTRY = {
  kind: 'finished',
  title: 'Your interview is complete',
  message: 'Thank you — the hiring team will be in touch.',
} as const satisfies PortalEntry;

const STOPPED_EARLY = 'This interview was stopped before it finished. The hiring team will contact you about next steps.';
const REPLY_TO_INVITATION = 'If you think that is wrong, reply to your invitation email and we will look into it.';

// Neutral wording throughout: several of these states have a cause that is as
// often ours as the candidate's, and none of them is a judgement of them.
const CLOSED_MESSAGES: Readonly<Record<string, { title: string; message: string }>> = {
  INCOMPLETE: { title: 'Your interview stopped part-way', message: STOPPED_EARLY },
  POLICY_STOP: { title: 'Your interview stopped part-way', message: STOPPED_EARLY },
  // Also the state of an interview the candidate FINISHED whose processing
  // failed on our side (server services/incompleteInterviews.ts), so it must
  // not say the interview itself was cut short or that they did anything wrong.
  TECHNICAL_FAILURE: {
    title: 'We hit a problem on our side',
    message: 'Something went wrong on our side with this interview — nothing you did caused it. The hiring team will contact you about next steps; there is nothing you need to do right now.',
  },
  RESCHEDULE_REQUIRED: {
    title: 'Your interview is being rescheduled',
    message: 'This interview needs a new time. The hiring team will contact you to arrange it.',
  },
  NO_SHOW: {
    title: 'This interview is no longer open',
    message: `The time for this interview has passed. If you would still like to interview, reply to your invitation email and we will look into it.`,
  },
  CANDIDATE_WITHDREW: {
    title: 'You ended this interview',
    message: 'You chose to stop this interview, and there is nothing more to do here. If you would like to continue after all, reply to your invitation email.',
  },
  // Same words the engine uses when this state refuses a start, so the portal
  // and the room cannot tell the candidate two different things.
  MANUAL_HANDOFF: {
    title: 'A person will be in touch',
    message: 'You asked to be interviewed by a person instead. Our team has your request and will be in touch — there is nothing more to do here.',
  },
  CANCELLED: {
    title: 'This interview has been cancelled',
    message: `This interview is no longer taking place. ${REPLY_TO_INVITATION}`,
  },
};

/** A state this page does not know — a newer server, or a damaged row. */
const UNKNOWN: PortalEntry = {
  kind: 'closed',
  title: 'This interview is not open right now',
  message: `This interview is not open right now. ${REPLY_TO_INVITATION}`,
};

/**
 * `consented` is whether consent is on record (GET /api/portal/:token sends
 * it). It matters only past the consent step and before the interview is live:
 * a live interview could not have started without it.
 */
export function portalEntry(state: string, consented = false): PortalEntry {
  if (JOURNEY_STATES.includes(state)) return { kind: 'journey' };
  if (IN_PROGRESS_STATES.includes(state)) {
    return {
      kind: 'rejoin',
      title: 'Your interview is in progress',
      message: 'You can pick up where you left off. Everything you have said so far is saved.',
      action: 'Rejoin interview',
    };
  }
  if (READY_STATES.includes(state)) {
    if (!consented) return UNKNOWN;
    return {
      kind: 'rejoin',
      title: 'Your interview is ready',
      message: 'You have already agreed to the interview, so you can go straight in.',
      action: 'Join interview',
    };
  }
  if (FINISHED_STATES.includes(state)) return FINISHED_ENTRY;
  const closed = CLOSED_MESSAGES[state];
  return closed ? { kind: 'closed', ...closed } : UNKNOWN;
}

/**
 * A refused consent or audio check, read as what it tells us about the
 * interview rather than as an error.
 *
 * WHY: the page may have been opened before the interview finished — in another
 * tab, or on another device — so its state is stale by the time the button is
 * pressed. The server's 410 "already been completed" is the answer "you are
 * done", and showing it as a red error made a finished interview look broken.
 * Anything else returns null and is shown as the error it is.
 */
export function entryFromRefusal(status: number | undefined, message: string): PortalEntry | null {
  if (status === 410 && /already been completed/i.test(message)) return FINISHED_ENTRY;
  return null;
}
