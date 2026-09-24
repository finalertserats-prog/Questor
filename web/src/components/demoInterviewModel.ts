/**
 * The demo interview's browser-side wording and state, free of React so it can
 * be read and tested on its own.
 *
 * THE PAGE DOES NOT ENFORCE ANYTHING HERE. The fifteen minutes, the one
 * extension and the close are all the server's, and every value below is
 * something the server sent. What lives here is how those values are SHOWN —
 * including, deliberately, when not to show them at all.
 */

export type DemoMode = 'candidate' | 'observer';

export interface DemoClock {
  readonly msLeft: number;
  readonly mayExtend: boolean;
  readonly closing: boolean;
  readonly ended: boolean;
}

/**
 * How the remaining time reads, for a viewer who asks for it.
 *
 * Rounded UP to the minute and never to a running second count. A demo is not
 * an exam, and a second-by-second clock in the corner of an interview makes
 * people watch the clock instead of the interview — which is worse for
 * somebody using a screen reader, where a live-updating number is read aloud
 * over the interviewer.
 */
export function timeLeftText(clock: DemoClock): string {
  if (clock.ended) return 'This demo interview has finished.';
  const minutes = Math.ceil(clock.msLeft / 60_000);
  if (minutes <= 0) return 'Wrapping up now.';
  if (minutes === 1) return 'About a minute left.';
  return `About ${minutes} minutes left.`;
}

/**
 * Whether the page may show a timer at all.
 *
 * It may not while the interview is running. The interviewer says when it is
 * moving to the close, in its own words, and a countdown beside it would be
 * the product talking over its own interviewer — exactly the "your limit has
 * been reached" the owner ruled out. The clock is available on request, from
 * a control the viewer presses, and nowhere else.
 */
export function timerMayBeShown(clock: DemoClock, viewerAsked: boolean): boolean {
  return clock.ended || viewerAsked;
}

/**
 * The speak-your-feedback route, decided from what the browser can actually do.
 *
 * Three outcomes, not two: a browser with no recogniser must not be shown a
 * button that does nothing, and a browser that has one still needs the visitor
 * told what it does before it is used.
 */
export type SpeechRoute = 'offer' | 'unsupported' | 'denied';

export function speechRoute(opts: { supported: boolean; micDenied: boolean }): SpeechRoute {
  if (!opts.supported) return 'unsupported';
  if (opts.micDenied) return 'denied';
  return 'offer';
}

/**
 * What the visitor is told about dictation BEFORE they press it.
 *
 * Says the two things that are true and are not obvious: the browser does the
 * listening, which on most browsers means the audio goes to Google; and typing
 * is always there. Never a warning shape — it is a choice, plainly described.
 */
export const SPEECH_NOTICE =
  'Your browser does the listening, not Questor. On Chrome and Edge that means the audio is sent to Google to be turned into text. We receive only the words, never the audio, and you can edit them before sending. Typing does the same job and sends nothing anywhere.';

export const SPEECH_UNSUPPORTED_NOTICE =
  'This browser cannot turn speech into text, so the box below is the way to do it here. Chrome and Edge can, if you would rather speak.';

export const MIC_DENIED_NOTICE =
  'Questor does not have permission to use your microphone, so dictation is off. The box below does the same job.';

/** What the room shows when a demo interview has closed at its box. */
export function afterTheBoxText(mode: DemoMode): string {
  return mode === 'candidate'
    ? 'The interviewer brought this one to a close, as it does in every demo. Your assessment is being written from what you said — the next page is the one a real candidate sees.'
    : 'The interview finished. The next page is the one the candidate sees afterwards; the assessment it produced is the product\'s own, written from the conversation you just watched.';
}

export type DemoFailure = 'sandbox_gone' | 'engine_unavailable' | 'already_taken' | 'network' | 'unknown';

export interface FailureCopy {
  readonly title: string;
  readonly message: string;
  /** What the visitor can actually do. Never "try again" when they cannot. */
  readonly action: string | null;
}

/**
 * Every way the demo can fail, written out rather than discovered.
 *
 * None of these apologise for a fault that is not one. A sandbox that has been
 * deleted was deleted on purpose; saying "something went wrong" about it would
 * be inaccurate and would make a deliberate privacy guarantee look like a bug.
 */
export function failureCopy(kind: DemoFailure): FailureCopy {
  switch (kind) {
    case 'sandbox_gone':
      return {
        title: 'This demo has been cleared',
        message: 'Demo sandboxes and everything in them — the interviews, the transcripts and the assessments — are deleted after seven days. This one has reached that point, so there is nothing left to open.',
        action: 'Ask for a new demo',
      };
    case 'engine_unavailable':
      return {
        title: 'The interview could not be run',
        message: 'We could not start the interviewer just now. Nothing has been recorded, and none of this is anything you did.',
        action: 'Tell us what you were trying to do',
      };
    case 'already_taken':
      return {
        title: 'This demo interview has already been taken',
        message: 'Each demo sandbox has one interview to sit. You can still watch one happen, as many times as you like.',
        action: 'Watch one instead',
      };
    case 'network':
      return {
        title: 'We cannot reach Questor',
        message: 'The connection dropped. Your place in the interview is kept on our side, so opening this page again picks it up where it was.',
        action: 'Try again',
      };
    default:
      return {
        title: 'Something did not work',
        message: 'We could not do that. Nothing has been lost.',
        action: 'Try again',
      };
  }
}

/** Map a refused request onto the failure the page knows how to explain. */
export function failureFor(status: number | undefined, code: string | undefined): DemoFailure {
  if (status === undefined) return 'network';
  if (code === 'sandbox_gone') return 'sandbox_gone';
  if (code === 'already_taken') return 'already_taken';
  if (status === 409) return 'sandbox_gone';
  return 'unknown';
}

/**
 * Which turns a screen reader should be told about, and which it should not.
 *
 * THE ROOM'S RULE, APPLIED TO A MODE IT DID NOT EXIST FOR (owner, 2026-09-23):
 * announce only what makes no sound. In observer mode NOTHING makes a sound —
 * the watcher is reading a transcript that is filling in — so here the rule
 * inverts: every new turn IS the event, and it is announced politely, once,
 * with the speaker named. Announcing it assertively would interrupt the
 * viewer mid-sentence every time the script moves on.
 */
export function observerAnnouncement(turn: { speaker: string; text: string } | undefined, interviewer: string, candidate: string): string {
  if (!turn) return '';
  const who = turn.speaker === 'agent' ? interviewer : candidate;
  return `${who} said: ${turn.text}`;
}
