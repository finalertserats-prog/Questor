import { useEffect, useRef } from 'react';
import {
  SILENT_SAMPLES, countSilence, micSeemsDead, timeLeftStage, type RoomEvent, type TimeStage,
} from './roomAnnouncements';
import type { RoomObserver } from './ParticipantsRail';

/**
 * The room's silent events, watched for and said once.
 *
 * Everything here has the same shape: a sighted candidate has a signal for it
 * (a flat level meter, a clock in the bar, a face appearing in the rail) and a
 * blind candidate has none. Nothing here is audible — the interviewer's voice,
 * the turn-taking and the check-ins are left alone on purpose.
 */

/** How often the microphone level is sampled while an answer is being spoken. */
const SILENCE_SAMPLE_MS = 1_000;
/** How often the clock is checked. Fine-grained enough for a one-minute warning. */
const CLOCK_TICK_MS = 10_000;

export interface RoomAnnouncementSignals {
  readonly announce: (event: RoomEvent | null) => void;
  /** The interview is under way: not the join screen, not the ending. */
  readonly live: boolean;
  /** Voice capture is open for this answer right now. */
  readonly capturing: boolean;
  readonly interim: string;
  readonly getCandidateLevel: () => number;
  readonly durationMinutes: number;
  /** Epoch ms the interview started, or 0 before it has. */
  readonly startedAtRef: { readonly current: number };
  /** Identifies the answer under way, so one turn is warned about once. */
  readonly turnKey: string;
  readonly observers: readonly RoomObserver[];
}

/**
 * Whether an observer arrived or left.
 *
 * One at a time is what actually happens: a hiring manager drops in to watch.
 * If two ever changed between renders the newer one is announced and the other
 * is left to the rail, which is a better trade than a sentence nobody parses.
 */
export function observerChange(
  before: readonly RoomObserver[],
  after: readonly RoomObserver[],
): RoomEvent | null {
  const joined = after.find((o) => !before.some((was) => was.name === o.name));
  if (joined) return { kind: 'observer-joined', name: joined.name };
  const left = before.find((was) => !after.some((o) => o.name === was.name));
  return left ? { kind: 'observer-left', name: left.name } : null;
}

export function useRoomAnnouncements(signals: RoomAnnouncementSignals): void {
  const ref = useRef(signals);
  ref.current = signals;
  const { announce, live, capturing, durationMinutes, turnKey } = signals;

  // The bar shows "about 5 min left" and a filling track; this is the same
  // thing said aloud, once per milestone. The stage is remembered rather than
  // left to the announcer's dedupe, which only compares with the last thing
  // said — something else in between would let a warning repeat.
  const saidStage = useRef<TimeStage | null>(null);
  useEffect(() => {
    if (!live) { saidStage.current = null; return undefined; }
    const check = () => {
      const startedAt = ref.current.startedAtRef.current;
      if (!startedAt) return;
      const stage = timeLeftStage(durationMinutes, Date.now() - startedAt);
      if (!stage || stage === saidStage.current) return;
      saidStage.current = stage;
      announce({ kind: 'time-left', stage });
    };
    const timer = window.setInterval(check, CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [live, durationMinutes, announce]);

  // A microphone that is open but hearing nothing. The level meter says this
  // to anyone who can see it and to nobody who cannot.
  const silentFor = useRef(0);
  useEffect(() => {
    silentFor.current = 0;
    if (!capturing) return undefined;
    const sample = () => {
      const now = ref.current;
      silentFor.current = countSilence(silentFor.current, {
        level: now.getCandidateLevel(),
        heardWords: now.interim.trim().length > 0,
      });
      if (micSeemsDead(silentFor.current)) announce({ kind: 'mic-silent', turn: now.turnKey });
      // Never let the count run away; it only has to reach the threshold once.
      if (silentFor.current > SILENT_SAMPLES) silentFor.current = SILENT_SAMPLES + 1;
    };
    const timer = window.setInterval(sample, SILENCE_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [capturing, turnKey, announce]);

  // Someone from the hiring team watching is silent, and the candidate has a
  // right to know. (The room is not yet told who is present — the rail is
  // given an empty list — so this waits for that signal rather than inventing
  // one; the day presence arrives, it is already announced.)
  const seen = useRef<readonly RoomObserver[]>(signals.observers);
  useEffect(() => {
    const event = observerChange(seen.current, signals.observers);
    seen.current = signals.observers;
    announce(event);
  }, [signals.observers, announce]);
}
