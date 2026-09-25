/**
 * When an observed human round may be entered, and what it means when it
 * cannot.
 *
 * THE DECISION THIS FILE ENCODES (owner, 2026-09-25). Every human round is
 * recorded by the AI observer, automatically — nobody presses record. The
 * reason is not convenience: an assessment has to be able to show the words
 * behind a claim, the Silver AI round already can, and Gold is the senior
 * credential of the two. A human round that ran unrecorded is therefore not a
 * round with weaker evidence; it is a round with none, and a Gold certificate
 * on top of it would rest on nothing.
 *
 * CONSENT IS A GATE ON ENTERING THE ROOM, NEVER A BUTTON DURING IT. That is
 * what makes "always recorded" and "always consented" the same sentence rather
 * than two that compete. Everyone whose voice may be captured — the candidate,
 * whoever is conducting, and HR if they join — passes the notice before they
 * are admitted, so by construction there is nobody in the room who has not
 * agreed. There is deliberately NO branch anywhere that begins capture on a
 * missing or absent consent: Illinois BIPA, NYC Local Law 144 and GDPR each
 * treat that as a serious problem, and Questor already carries roles under all
 * three (domain/roleJurisdiction.ts).
 *
 * AND SO, IF SOMEONE DECLINES, THE ROUND DOES NOT HAPPEN. Not "happens
 * unrecorded", not "happens with notes only". `roundBlock` below is how that
 * refusal reaches a person: a sentence saying why and what can be done next,
 * never a status code, and never a word about whose fault it is. Declining to
 * be recorded is a legitimate choice. The same discipline as `notesWithheld`
 * on the pipeline — a round that cannot go ahead must never read like a round
 * nobody got round to booking.
 */

export const OBSERVED_PARTIES = ['candidate', 'interviewer', 'hr'] as const;
export type ObservedParty = (typeof OBSERVED_PARTIES)[number];

export function isObservedParty(value: string): value is ObservedParty {
  return (OBSERVED_PARTIES as readonly string[]).includes(value);
}

/**
 * Without these two there is no round to observe. HR is deliberately absent:
 * they may join and are captured when they do, but a round must not be held
 * hostage to whether a colleague who was never required got round to reading a
 * notice.
 */
export const REQUIRED_PARTIES: readonly ObservedParty[] = ['candidate', 'interviewer'];

export const ENTRY_NOTICE_VERSION = 'observer-entry-v1';

/**
 * The whole disclosure, in one place and in the same words for everybody.
 *
 * One text rather than a candidate version and a staff version: the parties
 * are agreeing to the same processing, and two wordings would be two things to
 * keep true. It is written in the third person for that reason.
 */
export const ENTRY_NOTICE =
  'This interview is recorded. Questor transcribes what everyone in the room says — the candidate, the person '
  + 'conducting the interview, and anyone else from the hiring team who joins — and keeps the written transcript. '
  + 'The audio itself is never stored. The transcript, and the word-for-word quotes taken from it, are read by the '
  + 'hiring team for this role and are the evidence behind the assessment; Questor does not score, rate, summarise '
  + 'or recommend anyone from them — the people interviewing do that. Nobody enters this room without agreeing to '
  + 'this first, so nothing is captured that everyone present has not agreed to.';

/** What the round cannot do if you do not agree, said before you decide. */
export const ENTRY_CONSEQUENCE =
  'Agreeing is how you join. If you would rather not be recorded, this round will not go ahead as booked and the '
  + 'hiring team will be told so they can talk to you about what happens instead.';

export type ObservationStatus =
  | 'AWAITING_CONSENT' | 'CONSENTED' | 'LISTENING' | 'STOPPED' | 'DECLINED' | 'ENDED';

/** One person's standing in an observed round, as the gate needs to see it. */
export interface ParticipantRef {
  readonly party: ObservedParty;
  readonly personId: string;
  readonly consentAt: Date | null;
  readonly declinedAt: Date | null;
}

export function hasConsented(p: ParticipantRef | null | undefined): boolean {
  return !!p && p.consentAt !== null && p.declinedAt === null;
}

/**
 * The required parties who have not yet agreed. Empty means the gate can open.
 *
 * EVERY required ROW, not one row per party. A Gold round may be booked with
 * two people conducting it, and both are given a row when it is booked. Asking
 * only whether SOME interviewer has agreed would let the first of them open the
 * room while the second's row was still blank — and the first one's device
 * hears the second, who is on the same call whether or not they ever opened
 * Questor. That is capture without consent, in the ordinary case rather than a
 * race. (Found by a Codex review of this change, 2026-09-25.)
 *
 * The cost is deliberate: a colleague who was booked onto the round and never
 * answers holds it up. The room says which party it is waiting for, so that is
 * a thing somebody can act on rather than a silence — and the alternative is
 * recording a person who did not agree.
 *
 * A party with no row at all is outstanding too: a round nobody is seated on
 * has no interviewer until whoever runs it agrees to conduct it.
 */
export function consentOutstanding(participants: readonly ParticipantRef[]): readonly ObservedParty[] {
  return REQUIRED_PARTIES.filter((party) => {
    const rows = participants.filter((p) => p.party === party);
    return rows.length === 0 || rows.some((row) => !hasConsented(row));
  });
}

/** The first person who said no, in the order the parties are listed. */
export function firstDecline(participants: readonly ParticipantRef[]): ParticipantRef | null {
  for (const party of OBSERVED_PARTIES) {
    const declined = participants.find((p) => p.party === party && p.declinedAt !== null);
    if (declined) return declined;
  }
  return null;
}

/**
 * The decline that stops the round happening, as opposed to one that merely
 * means somebody is not coming.
 *
 * Only a required party can stop it. An HR colleague who reads the notice and
 * would rather not be recorded is not a blocker — they stay out of the room and
 * the interview goes ahead without them, which is the honest consequence of
 * their choice rather than a veto over somebody else's interview. They are
 * still not captured, because nothing admits a person who has not agreed.
 */
export function blockingDecline(participants: readonly ParticipantRef[]): ParticipantRef | null {
  return participants.find((p) => p.declinedAt !== null && REQUIRED_PARTIES.includes(p.party)) ?? null;
}

/**
 * Whether capture may run at all. Never true while a required party is
 * outstanding, whatever the observation's status column happens to say: the
 * status is a cache of this answer and the rows are the answer itself, so a
 * status written by an older version of this code cannot open the gate.
 */
export function captureConsented(participants: readonly ParticipantRef[]): boolean {
  return blockingDecline(participants) === null && consentOutstanding(participants).length === 0;
}

// ---------------------------------------------------------------------------
// Entering the room

export interface RoundBlock {
  /** Why it cannot go ahead, in a sentence a person can act on. */
  readonly reason: string;
  /** What they may do instead. Never empty: a refusal with no way out is a dead end. */
  readonly nextSteps: readonly string[];
}

const REBOOK = 'Talk to them, and rebook this round once everyone who would be in the room is content to be recorded.';
const MOVE_ON = 'Or take the candidate out of this stage, recording the reason with the decision.';

const DECLINED_BY: Readonly<Record<ObservedParty, string>> = {
  candidate: 'The candidate has not agreed to this round being recorded.',
  interviewer: 'The interviewer has not agreed to this round being recorded.',
  hr: 'Someone from the hiring team who was to join has not agreed to this round being recorded.',
};

const WHY_RECORDED =
  'Every human round is recorded, because the assessment has to be able to show the words behind it, so this '
  + 'round cannot go ahead as booked.';

/**
 * Why a round cannot go ahead, or null when nothing is standing in its way.
 *
 * Read from the participant rows rather than from the status column wherever
 * the two could differ, for the reason given on `captureConsented`.
 */
export function roundBlock(input: {
  readonly status: ObservationStatus;
  readonly participants: readonly ParticipantRef[];
  readonly roundStatus: string;
}): RoundBlock | null {
  // A round that already ran, or that the team cancelled, is not blocked; it is
  // over. Saying otherwise would put a live blocker in the queue for something
  // nobody can act on any more.
  if (input.roundStatus !== 'SCHEDULED') return null;

  const declined = blockingDecline(input.participants);
  if (declined || input.status === 'DECLINED') {
    const opening = declined ? DECLINED_BY[declined.party] : DECLINED_BY.candidate;
    return { reason: `${opening} ${WHY_RECORDED}`, nextSteps: [REBOOK, MOVE_ON] };
  }
  if (input.status === 'STOPPED') {
    return {
      reason: 'Recording stopped part-way through this round, so it cannot produce the transcript the assessment '
        + 'rests on. The part that was captured is kept, but it is not a record of the round.',
      nextSteps: [REBOOK, MOVE_ON],
    };
  }
  return null;
}

export type EntryDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly nextSteps: readonly string[] };

const ALLOWED: EntryDecision = { allowed: true };

const NOT_CONSENTED =
  'You have not agreed to be recorded in this round yet, so you cannot join it. Read what is captured and agree, '
  + 'or say no and the hiring team will be told the round cannot go ahead.';

const OVER = 'This round is over, so there is nothing to join.';

/**
 * May this person enter the room right now?
 *
 * Deliberately the ONLY answer to that question, called by every route that
 * could admit somebody — the room itself, a rejoin, a link opened cold, a
 * colleague arriving from another page. A second copy of this reasoning next to
 * one of those routes is how one path ends up a version behind the others.
 */
export function mayEnterRoom(input: {
  readonly status: ObservationStatus;
  readonly participants: readonly ParticipantRef[];
  readonly roundStatus: string;
  /** The person asking, or null when they are not in this round at all. */
  readonly me: ParticipantRef | null;
}): EntryDecision {
  const blocked = roundBlock(input);
  if (blocked) return { allowed: false, reason: blocked.reason, nextSteps: blocked.nextSteps };
  if (input.roundStatus !== 'SCHEDULED' || input.status === 'ENDED') {
    return { allowed: false, reason: OVER, nextSteps: ['Read the round\'s transcript and record if it has one.'] };
  }
  if (!hasConsented(input.me)) {
    return { allowed: false, reason: NOT_CONSENTED, nextSteps: ['Read what is captured, then agree or decline.'] };
  }
  // Their own consent is not enough. Capture starts the moment the room is
  // entered, and it hears everyone — so a candidate who has not agreed must
  // keep the interviewer out too, not merely stay away themselves.
  const outstanding = consentOutstanding(input.participants);
  if (outstanding.length > 0) {
    return {
      allowed: false,
      reason: outstanding.includes('candidate')
        ? 'The candidate has not yet read what is captured and agreed to it, so the room is not open.'
        : 'Nobody is conducting this round yet, so the room is not open.',
      nextSteps: ['The room opens on its own the moment everyone has agreed.'],
    };
  }
  return ALLOWED;
}

/**
 * Who a member of staff is in an observed round.
 *
 * `seated` is a RoundInterviewer row — the person conducting. Anyone else on
 * the hiring team with the run of the process is HR, who may join to set the
 * context; that is expected behaviour rather than an exception. Someone who is
 * neither is nobody here, and gets nothing.
 *
 * `roundHasSeats` is the case that is easy to get wrong. A round may be booked
 * naming its interviewers as free text — an external panellist, or simply a
 * recruiter typing who will be there — and then nobody holds a seat. Calling
 * every such person HR would leave the round with no interviewer at all, so it
 * could never reach the point of being entered, and a round that cannot be
 * entered cannot run. When nobody is seated, whoever runs the process is the
 * one conducting it, which is what was true before seats existed.
 */
export function staffPartyFor(input: {
  readonly seated: boolean;
  readonly runsTheProcess: boolean;
  readonly roundHasSeats: boolean;
}): Extract<ObservedParty, 'interviewer' | 'hr'> | null {
  if (input.seated) return 'interviewer';
  if (!input.runsTheProcess) return null;
  return input.roundHasSeats ? 'hr' : 'interviewer';
}

// ---------------------------------------------------------------------------
// Whether capture is actually happening

/**
 * CONSENT IS NOT CAPTURE, and the difference is the other half of "every human
 * round is recorded".
 *
 * Questor does not join the meeting. It hears the round through a browser tab
 * on a device in it, and that tab can stop capturing with nothing to show for
 * it: the interviewer takes the call on their phone and never opens it, they
 * navigate away mid-round, the operating system hands the microphone to another
 * application, the tab is backgrounded and its timers throttled, the laptop
 * sleeps. In every one of those the interview goes ahead and the record says a
 * consented, listening observer — which is worse than an unobserved round,
 * because it asserts something untrue about evidence that is not there.
 *
 * So the observation carries `lastHeardAt`: the moment a device last proved it
 * was capturing. Silence past the window below is treated as not capturing.
 * This is DETECTION AND HONESTY ABOUT A GAP, never a second way to capture —
 * there is deliberately no server-side or bot-joins-the-call path here, which
 * is phase two with video and the owner has deferred it.
 */

/** Three missed 30-second chunks. Long enough not to fire on one slow upload. */
export const CAPTURE_SILENCE_MS = 90_000;

export type CaptureLiveness = 'live' | 'silent' | 'never_started' | 'not_running';

export interface CaptureAlarm {
  readonly liveness: CaptureLiveness;
  /** What to say, loudly, while it can still be fixed. '' when nothing is wrong. */
  readonly warning: string;
  /** Who is the only person who can fix it, so the warning reaches them. */
  readonly fixBy: 'interviewer' | null;
}

const CAPTURE_OK: CaptureAlarm = { liveness: 'live', warning: '', fixBy: null };
const NOT_RUNNING: CaptureAlarm = { liveness: 'not_running', warning: '', fixBy: null };

const SILENT_WARNING =
  'Questor is not hearing this round — recording has stopped. Nothing said since then is being captured, and this '
  + 'round has no evidence without it. Open Questor on the device you are taking the call on, allow the microphone, '
  + 'and leave the tab in front.';

const NEVER_WARNING =
  'Questor has not heard anything from this round yet. Recording runs from the device you are taking the call on, so '
  + 'open Questor there and allow the microphone — until then nothing is being captured.';

/**
 * Whether capture is running right now.
 *
 * Read from the clock rather than from a status, because every way this fails
 * fails silently: nothing tells the server that a tab was closed, so only the
 * absence of news can.
 */
export function captureLiveness(input: {
  readonly status: ObservationStatus;
  readonly lastHeardAt: Date | null;
  readonly startedAt: Date | null;
  readonly now: Date;
}): CaptureAlarm {
  if (input.status !== 'LISTENING') return NOT_RUNNING;
  const heard = input.lastHeardAt ?? input.startedAt;
  // Listening with no start recorded at all: something opened the room without
  // going through `enterRoom`. Treated as not capturing rather than trusted.
  if (!heard) return { liveness: 'never_started', warning: NEVER_WARNING, fixBy: 'interviewer' };
  if (input.now.getTime() - heard.getTime() <= CAPTURE_SILENCE_MS) return CAPTURE_OK;
  return input.lastHeardAt
    ? { liveness: 'silent', warning: SILENT_WARNING, fixBy: 'interviewer' }
    : { liveness: 'never_started', warning: NEVER_WARNING, fixBy: 'interviewer' };
}

// ---------------------------------------------------------------------------
// What the round actually captured, said afterwards

export type CaptureCoverage = 'full' | 'partial' | 'one_sided' | 'none' | 'pending';

export interface CaptureReport {
  readonly coverage: CaptureCoverage;
  /**
   * One sentence about the RECORDING. Never about the candidate and never
   * about the interviewer: a device that stopped hearing is a fact about the
   * recording, and wording it as anybody's failure would be both wrong and the
   * kind of thing that stops people reporting it.
   */
  readonly sentence: string;
}

const NOTHING_CAPTURED =
  'Nothing was captured in this round. The recording did not run, so there is no transcript behind whatever the '
  + 'interviewer writes — and a round with no transcript is not evidence of what was said.';

const PART_CAPTURED =
  'Part of this round was not captured; the transcript marks where. Read the gaps as missing rather than as silence.';

/**
 * What a finished round holds, said plainly.
 *
 * Deliberately NOT a route to an unobserved round that still counts. It says
 * what is missing; it does not excuse it, and `evidenceKindOf`
 * (domain/roundEvidence.ts) still refuses to call a round with no captured
 * speech a transcript, so nothing here can quietly promote one.
 */
export function captureReport(input: {
  readonly status: ObservationStatus;
  readonly speechCount: number;
  readonly captureStatus: string;
  readonly oneSided: boolean;
}): CaptureReport {
  if (input.status !== 'ENDED') return { coverage: 'pending', sentence: '' };
  if (input.speechCount === 0) return { coverage: 'none', sentence: NOTHING_CAPTURED };
  // Ahead of the gap sentence: a round that heard one person is a worse thing
  // to be told about than a round with a few missing minutes, and saying only
  // the smaller of the two would leave the reader with the wrong worry.
  if (input.oneSided) return { coverage: 'one_sided', sentence: ONE_SIDED_REPORT };
  if (input.captureStatus === 'DEGRADED') return { coverage: 'partial', sentence: PART_CAPTURED };
  return { coverage: 'full', sentence: '' };
}

// ---------------------------------------------------------------------------
// Whether BOTH voices are being heard

/**
 * THE DEAF CAPTURE, which is worse than the dead one.
 *
 * Most interviewers wear a headset. The candidate's voice then never reaches
 * the device microphone at all — and nothing fails: every chunk uploads, every
 * transcription succeeds, no GAP is written, the observation sits at LISTENING.
 * What comes out is a complete-looking transcript in which the candidate never
 * said anything, and a reader cannot tell that from a candidate who said
 * nothing. It satisfies "there is a transcript" while containing one side of an
 * interview, which is precisely the thing the evidence principle exists to stop.
 *
 * DETECTING IT WITHOUT DIARISATION. Capture writes a segment only for speech it
 * heard: silence produces no segment, in either the browser recogniser or the
 * server path (an empty transcription stores nothing). So a device hearing both
 * people produces roughly the density of a conversation, and a device hearing
 * only the interviewer produces the density of one person's share of it — the
 * candidate's answers, which are most of an interview, arrive as silence.
 *
 * The measure is therefore captured speech per minute of elapsed round. Around
 * 150 words a minute of conversation is something like 800 characters; an
 * interviewer's own share of a competency interview is well under half of that.
 * The threshold is set low so a thoughtful, quiet round does not trip it, and it
 * waits for enough of the round to have passed to mean anything.
 *
 * It is a warning with a specific remedy, not a refusal: the person wearing the
 * headset is the only one who can fix it, and only while the round is running.
 */

/** Before this much has passed, a quiet stretch says nothing about the room. */
export const ONE_SIDED_MIN_ELAPSED_MS = 10 * 60_000;
/** A stretch this long with little in it means somebody was talking and was not heard. */
export const QUIET_STRETCH_MS = 20_000;
/** Conversational speech runs near 13 characters a second. This is well under it. */
export const QUIET_CHARS_PER_SECOND = 4;
/** Repeated, not one long think: a candidate reading code produces one or two. */
export const ONE_SIDED_MIN_STRETCHES = 6;
/** And they have to be most of the round, not a corner of it. */
export const ONE_SIDED_SHARE = 0.6;

export interface HearingCheck {
  readonly oneSided: boolean;
  /** The remedy, named. A generic warning does not get acted on. */
  readonly warning: string;
}

/**
 * One captured stretch, as this rule needs to see it.
 *
 * `durationMs` is wall clock, and that is the whole trick. The capture loop
 * hands over what it heard since the last time it heard anything, so a stretch
 * spans the silence before the words as well as the words — which makes a long
 * stretch holding few characters the exact shape of "somebody else was talking
 * and this device could not hear them".
 */
export interface CapturedStretch {
  readonly durationMs: number;
  readonly chars: number;
}

const HEARING_OK: HearingCheck = { oneSided: false, warning: '' };

const ONE_SIDED_WARNING =
  'Questor can hear you but not the candidate — take your headset off, or switch the call to your speakers. Right '
  + 'now this is recording one side of the interview, and one side is not evidence of what was said.';

/**
 * Whether the device is hearing one voice or two.
 *
 * Deliberately NOT an average over the round, which was the first attempt and
 * cried wolf: a candidate reading a problem, thinking, or working through a
 * coding exercise leaves a long quiet stretch on any device, and an average
 * cannot tell one of those from twenty. What distinguishes a headset is that
 * the quiet stretches REPEAT — one for every answer the candidate gives — and
 * that they are most of what the round consists of. Both conditions, so a
 * single silent ten minutes cannot trip it on its own.
 */
export function hearingCheck(input: {
  readonly elapsedMs: number;
  /** Zero stretches is a dead capture, not a deaf one. */
  readonly stretches: readonly CapturedStretch[];
}): HearingCheck {
  if (input.elapsedMs < ONE_SIDED_MIN_ELAPSED_MS) return HEARING_OK;
  // Nothing at all is `captureLiveness`'s problem, not this one. Reporting both
  // would put two different remedies in front of one person at once.
  if (input.stretches.length === 0) return HEARING_OK;
  const quiet = input.stretches.filter((stretch) => (
    stretch.durationMs >= QUIET_STRETCH_MS
    && stretch.chars / (stretch.durationMs / 1000) < QUIET_CHARS_PER_SECOND
  ));
  const oneSided = quiet.length >= ONE_SIDED_MIN_STRETCHES
    && quiet.length / input.stretches.length >= ONE_SIDED_SHARE;
  return oneSided ? { oneSided: true, warning: ONE_SIDED_WARNING } : HEARING_OK;
}

const ONE_SIDED_REPORT =
  'Only one voice was captured in this round. The recording heard the interviewer but not the candidate — a headset '
  + 'or an earpiece will do this — so what is stored is the interviewer\'s side of the conversation, not a transcript '
  + 'of the interview. It is not evidence of what the candidate said.';
