/**
 * What a candidate is allowed to be told about their own interview once it is
 * over, decided without touching the database so each rule is tested on its own
 * (tests/candidateStatusModel.test.ts).
 *
 * The hard rule this file exists to hold: NOTHING ASSESSED LEAVES HERE. No
 * score, no verdict, no recommendation, no competency level, no comparison with
 * anyone else. Every value below is either a date, a duration, a name the
 * candidate already knows, or an enum about the state of the *process* — never
 * about how they did. Keeping the derivation in one small file is what makes
 * that claim checkable: there is one place to look, and nothing here reads
 * `recommendation`, `disposition` or `resultJson` at all.
 *
 * The second rule: honest wording where we have no date. A candidate reading
 * this page is waiting on a decision about their livelihood, so a made-up
 * "within 24 hours" is worse than "a person is reading it". Where a fact is
 * absent the outlook says so and carries `dueAt: null`, and the page prints the
 * honest sentence rather than a guess.
 */

/** What actually happened to the interview, in the candidate's terms. */
export type StatusOutcome =
  /** They finished it. */
  | 'completed'
  /** They chose to stop. Never a failure, and never scored. */
  | 'withdrawn'
  /** It stopped part-way, from either side. */
  | 'incomplete'
  /** It broke on our side. Ours to own, not theirs to explain. */
  | 'technical'
  /** It needs a new time. */
  | 'rescheduling'
  /** The time passed without them. */
  | 'no_show'
  /** They asked for a person, and a person has it. */
  | 'handoff'
  /** It is not happening. */
  | 'cancelled'
  /** A state this build does not know, or one with nothing to say. */
  | 'closed';

/** Mirrors FINISHED_STATES in web/src/components/portalEntryModel.ts. */
const FINISHED_STATES: readonly string[] = ['CLOSING', 'PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED'];

const OUTCOME_BY_STATE: Readonly<Record<string, StatusOutcome>> = {
  CANDIDATE_WITHDREW: 'withdrawn',
  INCOMPLETE: 'incomplete',
  POLICY_STOP: 'incomplete',
  TECHNICAL_FAILURE: 'technical',
  RESCHEDULE_REQUIRED: 'rescheduling',
  NO_SHOW: 'no_show',
  MANUAL_HANDOFF: 'handoff',
  CANCELLED: 'cancelled',
};

/**
 * `completedAt` is what separates a finished interview from one that merely
 * ended up in a finished-looking state: CLOSED is also where an abandoned
 * interview lands, and telling that candidate "thank you, that's complete"
 * would be a lie they would notice.
 */
export function statusOutcome(state: string, completedAt: Date | null): StatusOutcome {
  if (FINISHED_STATES.includes(state)) return completedAt ? 'completed' : 'incomplete';
  return OUTCOME_BY_STATE[state] ?? 'closed';
}

/**
 * The states in which this link is still an invitation rather than a status
 * page: before the interview (PRE_INTERVIEW_STATES in routes/portal.ts), ready
 * to be joined (STARTABLE_STATES), and mid-interview (LIVE_STATES).
 */
const STILL_AN_INVITATION: readonly string[] = [
  'PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'DISCLOSURE', 'CONSENTED',
  'WAITING', 'CONNECTING', 'WARMUP',
  'ASSESSING', 'CANDIDATE_QUESTIONS',
];

/**
 * Whether this link can still start or resume an interview.
 *
 * The status page is what the link becomes AFTERWARDS, so the status routes
 * refuse while this is true rather than telling someone who has not interviewed
 * yet that "this link has done its job". `completedAt` wins: an interview that
 * finished is over whatever state the row was left in.
 */
export function linkStillLeadsToInterview(state: string, completedAt: Date | null): boolean {
  return !completedAt && STILL_AN_INVITATION.includes(state);
}

/**
 * How long they talked, in whole minutes.
 *
 * Null rather than a guess whenever the two timestamps cannot produce an honest
 * number — a missing start, or a clock that went backwards. A conversation that
 * happened is never reported as "0 minutes"; the floor is one.
 */
export function interviewMinutes(startedAt: Date | null, completedAt: Date | null): number | null {
  if (!startedAt || !completedAt) return null;
  const ms = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.max(1, Math.round(ms / 60_000));
}

/** Where written feedback stands, without ever implying what it will say. */
export type FeedbackOutlook =
  /** It is here and can be read on this page. */
  | 'arrived'
  /** It is coming. `dueAt` when we know by when, null when we honestly do not. */
  | 'expected'
  /** A person has to read it first. No date, because we do not have one. */
  | 'with_a_person'
  /** They told us they did not want it. */
  | 'declined'
  /** This employer does not send written feedback at all. Said plainly. */
  | 'not_offered'
  /** There is no letter to wait for, and none is promised. */
  | 'none';

export interface FeedbackRow {
  readonly status: string;
  readonly sentAt: Date | null;
}

export interface FeedbackInput {
  readonly outcome: StatusOutcome;
  /** The reviewed draft → approve → send flow, off unless an admin turned it on. */
  readonly approvedFlowEnabled: boolean;
  /** The automatic letter after a completed interview, on unless switched off. */
  readonly autoEmailEnabled: boolean;
  /** The candidate's own answer, when they gave one. */
  readonly optInChoice: string | null;
  readonly delivery: FeedbackRow | null;
  readonly autoEmail: (FeedbackRow & { readonly nextAttemptAt: Date | null }) | null;
}

export interface FeedbackView {
  readonly outlook: FeedbackOutlook;
  /** When the letter is due, when a date exists. Never invented. */
  readonly dueAt: Date | null;
  /** When it went. */
  readonly sentAt: Date | null;
}

/** Statuses that mean the words are already with the candidate. */
const SENT_STATUSES: readonly string[] = ['SENT', 'SENT_UNVERIFIED'];
/** Statuses that mean it is waiting on a person rather than on a clock. */
const WITH_A_PERSON: readonly string[] = ['HELD', 'FAILED'];
/** Statuses that mean it is on its way. */
const IN_FLIGHT: readonly string[] = ['QUEUED', 'SENDING'];

export function feedbackOutlook(i: FeedbackInput): FeedbackView {
  const none: FeedbackView = { outlook: 'none', dueAt: null, sentAt: null };

  // Sent beats everything: whatever the policy says now, these words reached
  // them, and hiding them behind a switch flipped afterwards would be absurd.
  if (i.delivery && SENT_STATUSES.includes(i.delivery.status)) {
    return { outlook: 'arrived', dueAt: null, sentAt: i.delivery.sentAt };
  }
  if (i.autoEmail && SENT_STATUSES.includes(i.autoEmail.status)) {
    return { outlook: 'arrived', dueAt: null, sentAt: i.autoEmail.sentAt };
  }

  // "This employer doesn't send written feedback" — said plainly, rather than
  // leaving someone checking a page for a letter that will never come.
  if (!i.approvedFlowEnabled && !i.autoEmailEnabled) {
    return { ...none, outlook: 'not_offered' };
  }
  if (i.optInChoice !== null && i.optInChoice !== 'YES') {
    return { ...none, outlook: 'declined' };
  }
  // Nothing is written about an interview that did not happen, and promising
  // one to a candidate who withdrew would be the cruellest kind of wrong.
  if (i.outcome !== 'completed') return none;

  if (i.autoEmail) {
    if (WITH_A_PERSON.includes(i.autoEmail.status)) return { ...none, outlook: 'with_a_person' };
    if (IN_FLIGHT.includes(i.autoEmail.status)) {
      return { outlook: 'expected', dueAt: i.autoEmail.nextAttemptAt, sentAt: null };
    }
    // DRAFT (previewed, never queued) or SKIPPED: nothing is coming on its own.
    return none;
  }

  // A draft exists but no one has approved it. That is a person's decision, and
  // we have no honest date for when a person will make it.
  if (i.delivery) return { ...none, outlook: 'with_a_person' };

  // The automatic letter is switched on and the row has not been written yet —
  // it is prepared when the assessment is stored. On its way, date unknown.
  if (i.autoEmailEnabled) return { outlook: 'expected', dueAt: null, sentAt: null };

  // Only the approve-and-send flow is on, and nobody has started a draft.
  return { ...none, outlook: 'with_a_person' };
}

/**
 * When what is kept about this interview is due to be deleted.
 *
 * Mirrors resolveRetainUntil in services/dataRights.ts: the window runs from
 * the end of the interview, or from when it was set up if it never finished.
 * Shown to the candidate because "what we keep and for how long" is only a real
 * answer with a date on it.
 */
export function retentionUntil(
  s: { readonly retainUntil: Date | null; readonly completedAt: Date | null; readonly createdAt: Date },
  days: number,
): Date {
  if (s.retainUntil) return s.retainUntil;
  const from = s.completedAt ?? s.createdAt;
  return new Date(from.getTime() + days * 24 * 60 * 60_000);
}
