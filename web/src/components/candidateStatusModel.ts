/**
 * What the candidate's status page says, in words, decided away from React so
 * every sentence can be read and tested on its own
 * (web/tests/candidateStatusModel.test.ts).
 *
 * The page is the last thing many people will ever see of this product, and
 * most of them will be reading it after being turned down. Three rules run
 * through every line below:
 *
 *   NOTHING ASSESSED. No score, no verdict, no competency, no recommendation,
 *   nothing about another candidate. The server does not send any of it (see
 *   server/src/domain/candidateStatusModel.ts); this file could not print it
 *   if it tried, and the enums are the reason why.
 *
 *   NO INVENTED DATES. Where we have a date we give it. Where we do not, we say
 *   what is actually true — "a person is reading it" — rather than a
 *   comfortable "within 48 hours" that nobody promised.
 *
 *   NO DEAD PROMISES. An organisation that does not send written feedback is
 *   said so plainly, once, rather than leaving someone refreshing a page for a
 *   letter that was never coming.
 */

import { TRUST_SECTION_ID } from './trustModel';

export type StatusOutcome =
  | 'completed' | 'withdrawn' | 'incomplete' | 'technical'
  | 'rescheduling' | 'no_show' | 'handoff' | 'cancelled' | 'closed';

export type FeedbackOutlook =
  'arrived' | 'expected' | 'with_a_person' | 'declined' | 'not_offered' | 'none';

export interface StatusRound {
  readonly scheduledAt: string;
  readonly timeZone: string | null;
  readonly text: string;
  readonly interviewers: readonly string[];
  readonly booked: boolean;
}

/** The server's CandidateStatusView, as JSON puts it on the wire. */
export interface StatusView {
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly organisation: string;
  readonly interviewer: string | null;
  readonly outcome: StatusOutcome;
  readonly timeZone: string | null;
  readonly appliedAt: string | null;
  readonly appliedKind: 'application' | 'invitation' | null;
  readonly interviewAt: string | null;
  readonly interviewMinutes: number | null;
  readonly readByTeamAt: string | null;
  readonly nextRound: StatusRound | null;
  readonly decisionSharedAt: string | null;
  readonly feedback: { readonly outlook: FeedbackOutlook; readonly dueAt: string | null; readonly sentAt: string | null };
  readonly talkToAPerson: { readonly requested: boolean; readonly requestedAt: string | null };
  readonly retainUntil: string;
}

// ---------------------------------------------------------------------------
// Dates, on the clock the interview was booked on
// ---------------------------------------------------------------------------

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function usableZone(timeZone: string | null): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    // A zone this browser does not know is not worth failing a page over.
    return undefined;
  }
}

/** "Tue 22 Sep" — enough to recognise the day, short enough for a phone. */
export function statusDay(value: string | null, timeZone: string | null): string {
  const at = parse(value);
  if (!at) return '';
  return at.toLocaleDateString('en-GB', {
    timeZone: usableZone(timeZone), weekday: 'short', day: 'numeric', month: 'short',
  });
}

/**
 * "Tue 22 Sep, 18:05 GMT+5:30 (13:35 your time)" — used only where the hour
 * genuinely matters.
 *
 * The hiring team's clock first, because that is the clock the deadline was
 * set on, and the candidate's own alongside it when the two differ. This page
 * is the one place in Questor where the reader's zone is genuinely knowable —
 * it is their own browser — and leaving them to convert an hour that is about
 * them was the last silent conversion on it.
 */
export function statusMoment(
  value: string | null,
  timeZone: string | null,
  viewerZone: string | undefined = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const at = parse(value);
  if (!at) return '';
  const zone = usableZone(timeZone);
  const stated = at.toLocaleString('en-GB', {
    timeZone: zone, weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  });
  const viewer = usableZone(viewerZone ?? null);
  if (!viewer) return stated;
  const clock = (z: string | undefined) => at.toLocaleTimeString('en-GB', { timeZone: z, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return clock(viewer) === clock(zone) ? stated : `${stated} (${clock(viewer)} your time)`;
}

/** The name they are greeted by. Their own first name, never a nickname we invented. */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
}

// ---------------------------------------------------------------------------
// The thank-you
// ---------------------------------------------------------------------------

const HEADINGS: Readonly<Record<StatusOutcome, (name: string) => string>> = {
  completed: (name) => (name ? `Thanks, ${name}. That was a good conversation.` : 'Thank you — that was a good conversation.'),
  withdrawn: (name) => (name ? `Thanks for your time, ${name}.` : 'Thanks for your time.'),
  incomplete: (name) => (name ? `Thanks for making a start, ${name}.` : 'Thanks for making a start.'),
  technical: (name) => (name ? `Sorry, ${name} — that one was on us.` : 'Sorry — that one was on us.'),
  rescheduling: (name) => (name ? `We need a new time, ${name}.` : 'We need a new time.'),
  no_show: (name) => (name ? `This interview has closed, ${name}.` : 'This interview has closed.'),
  handoff: (name) => (name ? `A person will be in touch, ${name}.` : 'A person will be in touch.'),
  cancelled: (name) => (name ? `This interview is no longer going ahead, ${name}.` : 'This interview is no longer going ahead.'),
  closed: (name) => (name ? `Here is where things stand, ${name}.` : 'Here is where things stand.'),
};

export function statusHeading(v: StatusView): string {
  return HEADINGS[v.outcome](firstName(v.candidateName));
}

/**
 * The line that retires the link.
 *
 * Said in the opening paragraph rather than as an error the candidate discovers
 * by pressing something: the link they were sent is the only address they have
 * for this, and "it can't start another interview, but it will always show you
 * where things stand" is the whole change, in one sentence.
 */
// "Will keep showing you", not "will always show you": the link stops working
// when the invitation is erased at the candidate's own request, and when what
// we keep about the interview reaches the end of its retention (the date is in
// the foot of this page). Promising "always" would be a promise the product
// deliberately does not keep.
export const LINK_IS_SPENT = 'This link has done its job. It can’t start another interview, '
  + 'but it will keep showing you where things stand.';

/** How the conversation is described back to them: only facts we actually hold. */
export function conversationLine(v: StatusView): string {
  const role = `the ${v.roleTitle} role`;
  if (v.outcome !== 'completed') {
    return v.interviewer
      ? `Your conversation with ${v.interviewer} about ${role} did not run to the end.`
      : `Your first conversation about ${role} did not run to the end.`;
  }
  const who = v.interviewer ? `You talked with ${v.interviewer}` : 'You talked with our AI interviewer';
  const howLong = v.interviewMinutes ? ` for ${v.interviewMinutes} ${plural(v.interviewMinutes, 'minute')}` : '';
  return `${who}${howLong} about ${role}.`;
}

/** "1 minute", not "1 minutes": a short interview should not read as a typo. */
function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

// ---------------------------------------------------------------------------
// "Where you are"
// ---------------------------------------------------------------------------

export type StepState = 'done' | 'now' | 'later';

export interface StatusStep {
  readonly key: string;
  readonly title: string;
  /** The date, the wait, or the honest "we don't know yet". Never a guess. */
  readonly detail: string;
  readonly state: StepState;
}

export const WHERE_YOU_ARE = 'Where you are';

/**
 * What ended it, for an interview that did not finish, and what follows.
 *
 * `detail` is the step on the timeline; `next` is the "what happens next" box.
 * They are deliberately different sentences: printing one line twice on a short
 * page reads as a page that is broken, or as insistence.
 */
const ENDED: Readonly<Record<Exclude<StatusOutcome, 'completed'>, { title: string; detail: string; next: string }>> = {
  withdrawn: {
    title: 'You ended the interview',
    detail: 'It was not scored and it does not count against you.',
    next: 'Nothing is being assessed. If you would like to pick this up again, or to talk it through, '
      + 'ask to speak to someone below.',
  },
  incomplete: {
    title: 'The interview stopped part-way',
    detail: 'Only part of the conversation was recorded.',
    next: 'The hiring team will contact you about next steps. There is nothing you need to do right now.',
  },
  technical: {
    title: 'Something went wrong on our side',
    detail: 'Nothing you did caused it.',
    next: 'The hiring team will contact you about next steps, and can arrange another time if you want one.',
  },
  rescheduling: {
    title: 'A new time is being arranged',
    detail: 'This interview needs rebooking.',
    next: 'The hiring team will contact you to agree a time that suits you.',
  },
  no_show: {
    title: 'The time for this interview passed',
    detail: 'The conversation did not take place.',
    next: 'If you would still like to interview, ask to speak to someone below and we will look into it.',
  },
  handoff: {
    title: 'A person is taking this one',
    detail: 'You asked to be interviewed by a person.',
    next: 'The hiring team has your request and will be in touch to arrange it.',
  },
  cancelled: {
    title: 'This interview was cancelled',
    detail: 'It is no longer taking place.',
    next: 'If you think that is wrong, ask to speak to someone below.',
  },
  closed: {
    title: 'This interview is not open',
    detail: 'There is nothing further to do here.',
    next: 'The hiring team will be in touch if there is anything more.',
  },
};

export function statusSteps(v: StatusView): readonly StatusStep[] {
  const applied: StatusStep = {
    key: 'applied',
    // Only "applied" when an application is what we actually hold. For an
    // invitation we say invitation: telling someone they applied on a day they
    // may not have is a small lie that makes the rest read as guesswork.
    title: v.appliedKind === 'application' ? 'Applied' : 'Invited to interview',
    detail: statusDay(v.appliedAt, v.timeZone) || 'Date not recorded',
    state: 'done',
  };

  const conversation: StatusStep = {
    key: 'interview',
    title: v.interviewer ? `First conversation, with ${v.interviewer}` : 'First conversation',
    detail: [statusDay(v.interviewAt, v.timeZone), v.interviewMinutes ? `${v.interviewMinutes} min` : '']
      .filter(Boolean).join(' · ') || 'Not recorded',
    state: 'done',
  };

  if (v.outcome !== 'completed') {
    const ended = ENDED[v.outcome];
    return [applied, { key: 'ended', title: ended.title, detail: ended.detail, state: 'now' }];
  }

  const read: StatusStep = v.readByTeamAt
    ? {
      key: 'review',
      title: 'Read by the hiring team',
      detail: statusDay(v.readByTeamAt, v.timeZone),
      state: 'done',
    }
    : {
      key: 'review',
      title: 'A person is reading it',
      detail: 'The whole conversation, not only a summary.',
      state: 'now',
    };

  const next: StatusStep = v.nextRound
    ? {
      key: 'next_round',
      title: v.nextRound.interviewers.length
        ? `A conversation with ${listNames(v.nextRound.interviewers)}`
        : 'A conversation with the team',
      detail: v.nextRound.booked ? v.nextRound.text : `${v.nextRound.text} — they will send you the details`,
      state: 'now',
    }
    : {
      key: 'next_round',
      title: 'A conversation with the team',
      detail: 'If both sides want to keep going.',
      state: 'later',
    };

  const decision: StatusStep = v.decisionSharedAt
    ? {
      key: 'decision',
      title: 'A decision, either way',
      detail: `Sent to you on ${statusDay(v.decisionSharedAt, v.timeZone)}.`,
      state: 'done',
    }
    : {
      key: 'decision',
      title: 'A decision, either way',
      detail: 'You will hear from the team whichever way it goes.',
      state: 'later',
    };

  // The read step stops being "now" once something later is happening.
  const readSettled: StatusStep = next.state === 'now' && read.state === 'now'
    ? { ...read, state: 'done', detail: 'Done.' }
    : read;

  return [applied, conversation, readSettled, next, decision];
}

function listNames(names: readonly string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// What happens next, and by when
// ---------------------------------------------------------------------------

export const NEXT_HEADING = 'What happens next';

/**
 * One sentence, and only ever about things that have a date or a named person
 * behind them. When neither exists it says the waiting is real rather than
 * dressing it up.
 */
export function whatHappensNext(v: StatusView): string {
  if (v.outcome !== 'completed') return ENDED[v.outcome].next;
  if (v.nextRound) {
    const when = v.nextRound.text;
    return v.nextRound.booked
      ? `Your next conversation is booked for ${when}. The invitation is already in your inbox.`
      : `Your next conversation is pencilled in for ${when}. The team will send you the details.`;
  }
  if (v.readByTeamAt) {
    return 'A person on the hiring team has read your interview. They will be in touch either way.';
  }
  return 'A person on the hiring team is reading your interview now. They will be in touch either way.';
}

// ---------------------------------------------------------------------------
// Written feedback
// ---------------------------------------------------------------------------

export const FEEDBACK_HEADING_WAITING = 'Your feedback';
export const FEEDBACK_HEADING_ARRIVED = 'Feedback from your conversation';

export function feedbackHeading(outlook: FeedbackOutlook): string {
  return outlook === 'arrived' ? FEEDBACK_HEADING_ARRIVED : FEEDBACK_HEADING_WAITING;
}

/**
 * What to say while there is nothing to read.
 *
 * `not_offered` is the sentence this whole section exists for. An organisation
 * that does not write to candidates should say so on the candidate's own page,
 * today, rather than letting them check it every morning for a fortnight.
 */
export function feedbackNote(v: StatusView, stillLoading = false): string {
  const { outlook, dueAt } = v.feedback;
  // `arrived` with no letter beside it. The page has already committed to the
  // heading "Feedback from your conversation", so the one thing it must not do
  // is leave an empty box under it. While the read is in flight it says so;
  // once the read has failed or found nothing it points at the inbox, which is
  // where the words certainly are — they were emailed before this page knew
  // about them.
  if (outlook === 'arrived') {
    if (stillLoading) return 'Loading your feedback…';
    return 'Your written feedback has been sent to you by email. '
      + 'We could not load it on this page just now — try again in a moment, or read it in your inbox.';
  }
  if (outlook === 'not_offered') {
    return `${v.organisation} does not send written feedback on interviews. `
      + 'That is their policy rather than a delay, so there is nothing to wait for — '
      + 'but you can still ask to speak to someone below.';
  }
  if (outlook === 'declined') {
    return 'You said you would rather not have written feedback, so none will be sent. '
      + 'If you have changed your mind, ask to speak to someone below.';
  }
  if (outlook === 'with_a_person') {
    return 'A person on the hiring team is reading your interview before any written feedback goes out, '
      + 'so there is no date to give you yet. You will be emailed when there is.';
  }
  if (outlook === 'expected') {
    const by = statusMoment(dueAt, v.timeZone);
    return by
      ? `Written feedback about your conversation should reach you by ${by}, and will appear here too. `
        + 'We will email it, so there is no need to keep checking.'
      : 'Written feedback about your conversation is being prepared and will appear here. '
        + 'We will email it too, so there is no need to keep checking.';
  }
  return 'There is no written feedback for this interview. '
    + 'If there is anything you would like to ask, speak to someone below.';
}

/**
 * The one thing the candidate must know about who wrote it — and it has to be
 * true of the letter they are actually reading. The automatic letter leaves 12
 * hours after the interview whether or not anyone has read it, so only a
 * reviewer-released letter may say the team checked it.
 */
export type LetterSource = 'reviewer' | 'automatic';

export function feedbackProvenance(source: LetterSource): string {
  return source === 'reviewer'
    ? 'Drafted by AI from your conversation, then read and released by the hiring team. '
      + 'Decisions are always made by people.'
    : 'Drafted by AI from your conversation and sent automatically. '
      + 'Decisions are always made by people, and you can ask to speak to someone below.';
}

// ---------------------------------------------------------------------------
// Talking to a person, and what is kept
// ---------------------------------------------------------------------------

export const TALK_HEADING = 'Would you rather talk to a person?';
export const TALK_INVITE = 'If you would rather talk this through with someone than read it, '
  + 'press the button and we will pass that on to the hiring team. Nobody will contact you unless you do.';
export const TALK_BUTTON = 'Yes, I’d like to speak to someone';
export const TALK_SENDING = 'Sending…';
export const TALK_RECORDED = 'Your request is with the hiring team. Someone will be in touch.';
export const TALK_FAILED = 'We could not record that just now. Please try again in a moment.';

/**
 * Where "what is kept about you, and for how long" points.
 *
 * The dedicated privacy page is being added by another lane, so this is written
 * to work either way: when the page exists it is linked, and until it does the
 * existing notice on the About page is, which says the same things in less
 * detail. A link to a route that does not exist would send a candidate asking a
 * data question to a blank screen, which is the worst possible answer to it.
 */
export const CANDIDATE_NOTICE_FALLBACK = `/about#${TRUST_SECTION_ID}`;
export const PRIVACY_ROUTE = '/privacy';

export function privacyNoticeHref(hasPrivacyPage: boolean): string {
  return hasPrivacyPage ? PRIVACY_ROUTE : CANDIDATE_NOTICE_FALLBACK;
}

/**
 * When what was kept from this interview is due to be deleted.
 *
 * Deliberately a bare day, with no hour and no zone named — reviewed
 * 2026-09-25 and left alone. Every other instant on this page gained a zone
 * because somebody has to be somewhere at that minute; a retention deadline is
 * not one of those. It is a window measured in months, the sentence already
 * says "due to be", and the day is written on the hiring organisation's
 * calendar, which is the calendar the obligation actually runs on. Adding
 * "17:30 GMT+5:30 (13:00 your time)" to a privacy sentence would make it
 * harder to read in exchange for a precision the underlying fact does not have.
 *
 * What would be wrong is converting it as if it were a plain date: it is a real
 * instant, statusDay renders it in one named zone, and that is stable for every
 * reader rather than shifting by a day with the browser.
 */
export function retentionLine(v: StatusView): string {
  const until = statusDay(v.retainUntil, v.timeZone);
  return until
    ? `What we keep from this interview — the written transcript, not a recording — is due to be deleted on ${until}.`
    : 'What we keep from this interview is the written transcript, not a recording.';
}

export const PRIVACY_LINK_TEXT = 'What is kept about you, and for how long';
