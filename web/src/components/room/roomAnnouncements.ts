/**
 * What the interview room says to a screen reader — and, just as importantly,
 * what it refuses to say.
 *
 * THE RULE (owner, 2026-09-23): announce only events that make NO sound and
 * carry no other non-visual signal. A blind candidate HEARS the interviewer.
 * Telling them "Maya is speaking", or captioning Maya's words as she says
 * them, is noise laid over noise — it reads as artificial because it is. The
 * room stays quiet about anything audible and speaks up about the rest:
 * whether it heard them, whether the microphone is working, whether the
 * connection held, who else is in the room, how much time is left, and how
 * the interview ended.
 *
 * `RoomEvent` is the whole permitted vocabulary, and it is the guard: there is
 * no case in it for the interviewer speaking, so there is no way to announce
 * one without editing this union — which is a change a reviewer will see.
 * `unspoken-turn` is the single, deliberate exception: when the browser has no
 * voice and no server voice answered, the interviewer's words made no sound at
 * all, and then the text IS the only signal there is.
 */

export type AnnouncementKind =
  | 'joined'
  | 'heard'
  | 'mic-unavailable'
  | 'mic-silent'
  | 'offline'
  | 'online'
  | 'observer-joined'
  | 'observer-left'
  | 'time-left'
  | 'ended'
  | 'unspoken-turn';

/** Every announceable event, in the order they are documented above. */
export const ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] = [
  'joined', 'heard', 'mic-unavailable', 'mic-silent', 'offline', 'online',
  'observer-joined', 'observer-left', 'time-left', 'ended', 'unspoken-turn',
];

export type TimeStage = 'five' | 'last' | 'over';

export type RoomEvent =
  /** The room opened and the interview is under way. The wait before the first question is silent. */
  | { readonly kind: 'joined' }
  /** They stopped answering and the room is working on it. `turn` keeps one answer from re-announcing. */
  | { readonly kind: 'heard'; readonly turn: string }
  /** The microphone could not be opened at all — permission refused, or no device. */
  | { readonly kind: 'mic-unavailable' }
  /** The microphone is open but nothing is reaching it. */
  | { readonly kind: 'mic-silent'; readonly turn: string }
  | { readonly kind: 'offline' }
  | { readonly kind: 'online' }
  | { readonly kind: 'observer-joined'; readonly name: string }
  | { readonly kind: 'observer-left'; readonly name: string }
  | { readonly kind: 'time-left'; readonly stage: TimeStage }
  | { readonly kind: 'ended'; readonly withdrawn: boolean }
  | { readonly kind: 'unspoken-turn'; readonly id: string; readonly interviewer: string; readonly text: string };

export interface Announcement {
  /** Identity of this occurrence. The same key twice running is not said twice. */
  readonly key: string;
  readonly message: string;
  /**
   * True only for something that changes what the candidate should do right
   * now — a microphone that is not working, a connection that has dropped.
   * Everything else waits for a gap, so it never talks over the interviewer.
   */
  readonly assertive: boolean;
  /**
   * This event ends the situation an interrupting message was about, so that
   * message comes down with it. Only for events that genuinely resolve one —
   * otherwise a polite line could wipe a warning nobody had read yet.
   */
  readonly clearsUrgent?: boolean;
}

const TIME_WORDS: Record<TimeStage, string> = {
  five: 'About five minutes left.',
  last: 'Less than a minute left.',
  over: "You're past the planned time. That's fine — carry on until the interviewer wraps up.",
};

export function announcementFor(event: RoomEvent): Announcement {
  switch (event.kind) {
    case 'joined':
      return { key: 'joined', message: "You're in the interview room. Your answer controls are below the conversation.", assertive: false };
    case 'heard':
      // Only what we actually know at that moment: we have the words and we
      // are sending them. Not "your answer was received" — a send can still
      // fail, and the room's error alert is what says so.
      return { key: `heard:${event.turn}`, message: 'Got it — sending your answer.', assertive: false };
    case 'mic-unavailable':
      return {
        key: 'mic-unavailable',
        message: "We couldn't open your microphone. Check its permission, or choose Type and answer with the keyboard — it counts exactly the same.",
        assertive: true,
      };
    case 'mic-silent':
      return {
        key: `mic-silent:${event.turn}`,
        message: "We're not picking up any sound. Check your microphone isn't muted, or choose Type and answer with the keyboard.",
        assertive: true,
      };
    case 'offline':
      return {
        key: 'offline',
        message: "You've gone offline. Hold on a moment while we reconnect — nothing you have said is lost.",
        assertive: true,
      };
    case 'online':
      return { key: 'online', message: "You're back online. Carry on where you left off.", assertive: false, clearsUrgent: true };
    case 'observer-joined':
      return {
        key: `observer-joined:${event.name}`,
        message: `${event.name} from the hiring team has joined and is watching. They take no part in the interview.`,
        assertive: false,
      };
    case 'observer-left':
      return { key: `observer-left:${event.name}`, message: `${event.name} has left the room.`, assertive: false };
    case 'time-left':
      return { key: `time-left:${event.stage}`, message: TIME_WORDS[event.stage], assertive: false };
    case 'ended':
      return {
        key: 'ended',
        message: event.withdrawn
          ? 'The interview has ended at your request. Your microphone is off, and what happens now is on the screen below.'
          : 'The interview has ended. Your microphone is off, and what happens now is on the screen below.',
        assertive: false,
        // Nothing urgent applies to a room that is over.
        clearsUrgent: true,
      };
    case 'unspoken-turn':
      // Nothing was heard for this turn, so its text is the only signal there
      // is. Never assertive: it is a question, not an emergency.
      return { key: `unspoken-turn:${event.id}`, message: `${event.interviewer}: ${event.text}`, assertive: false };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/**
 * Two slots per channel.
 *
 * A live region only announces when its text CHANGES, so writing "Got it — one
 * moment." into the same node after a second answer would be silent. The room
 * alternates between two nodes instead, clearing the one it is not using, so
 * an identical message is still a real change and is still read.
 */
export interface AnnouncerState {
  readonly lastKey: string;
  readonly polite: readonly [string, string];
  readonly politeSlot: 0 | 1;
  readonly assertive: readonly [string, string];
  readonly assertiveSlot: 0 | 1;
}

export const EMPTY_ANNOUNCER: AnnouncerState = {
  lastKey: '', polite: ['', ''], politeSlot: 1, assertive: ['', ''], assertiveSlot: 1,
};

function fill(text: string, slot: 0 | 1): readonly [string, string] {
  return slot === 0 ? [text, ''] : ['', text];
}

/**
 * Add an event to what is being announced, dropping one that is already being
 * said.
 *
 * The two channels are kept independently, and an ordinary message never
 * clears the interrupting one. Clearing looked tidy and was a bug: "we're
 * sending your answer" landing a moment after "you've gone offline" wiped the
 * urgent line off the page before a screen reader had finished with it.
 * Leaving it costs nothing — a live region only speaks when its text CHANGES
 * — and each channel takes its own slot so a repeat within a channel is still
 * a change. The exception is an event that ENDS the urgent situation (the
 * connection is back, the interview is over): it takes the warning down, so a
 * screen reader browsing the page later does not find a stale one.
 */
export function say(state: AnnouncerState, event: RoomEvent | null): AnnouncerState {
  if (!event) return state;
  const next = announcementFor(event);
  if (next.key === state.lastKey) return state;
  if (next.assertive) {
    const slot: 0 | 1 = state.assertiveSlot === 0 ? 1 : 0;
    return { ...state, lastKey: next.key, assertive: fill(next.message, slot), assertiveSlot: slot };
  }
  const slot: 0 | 1 = state.politeSlot === 0 ? 1 : 0;
  const assertive = next.clearsUrgent ? (['', ''] as const) : state.assertive;
  return { ...state, lastKey: next.key, polite: fill(next.message, slot), politeSlot: slot, assertive };
}

export function politeText(state: AnnouncerState): string {
  return state.polite[0] || state.polite[1];
}

export function assertiveText(state: AnnouncerState): string {
  return state.assertive[0] || state.assertive[1];
}

// ---------------------------------------------------------------------------
// A microphone that is open but hearing nothing.
//
// The commonest failure in a voice interview is a candidate talking to a muted
// input. A sighted candidate sees the level meter sitting flat; there is no
// other signal at all, so this is exactly the kind of silent event that has to
// be said out loud.

/** Level below which a sample counts as silence; speech sits far above it. */
export const SILENT_LEVEL = 0.02;
/** Samples (one a second) of unbroken silence before the room says anything. */
export const SILENT_SAMPLES = 8;

export function countSilence(previous: number, o: { readonly level: number; readonly heardWords: boolean }): number {
  if (o.heardWords || o.level > SILENT_LEVEL) return 0;
  return previous + 1;
}

/** Exactly at the threshold, so a long silence is mentioned once and not every second. */
export function micSeemsDead(count: number): boolean {
  return count === SILENT_SAMPLES;
}

// ---------------------------------------------------------------------------
// The clock.
//
// The top bar shows "about 5 min left" and a filling track. That is visual
// only, so the same milestones are said once each.

const MINUTE = 60_000;
const WARN_AT_MS = 5 * MINUTE;

export function timeLeftStage(durationMinutes: number, elapsedMs: number): TimeStage | null {
  if (elapsedMs <= 0) return null;
  const remaining = durationMinutes * MINUTE - elapsedMs;
  if (remaining <= 0) return 'over';
  if (remaining <= MINUTE) return 'last';
  if (remaining <= WARN_AT_MS) return 'five';
  return null;
}
