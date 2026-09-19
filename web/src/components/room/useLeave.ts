import { useRef } from 'react';
import { ApiError, api } from '../../api/client';
import type { StartedTurn } from '../roomResumeModel';
import { LEAVE_MARKER } from './roomComposerModel';
import { refusalOf } from './useRejoin';

/** A turn as the portal sends it, including whether it ended the interview at the candidate's request. */
export interface PortalTurn extends StartedTurn {
  readonly withdrawn?: boolean;
}

export interface LeaveDeps {
  readonly token: string;
  /** Whether the question on screen is the interviewer's sign-off. */
  readonly currentTurnDone: () => boolean;
  readonly textModeRef: { readonly current: boolean };
  readonly pausedRef: { readonly current: boolean };
  readonly answerInProgress: () => boolean;
  readonly reopenAnswer: () => void;
  readonly holdCapture: () => Promise<void>;
  readonly beginListening: (opts: { resume?: boolean }) => Promise<void>;
  readonly stopSpeech: () => void;
  /** Stop the word-by-word reveal of a question whose speech was cut off. */
  readonly clearReveal: () => void;
  readonly setPhase: (phase: 'listening' | 'thinking') => void;
  readonly setErr: (message: string) => void;
  readonly showFinished: () => void;
  /** The interview had already ended from elsewhere: show the ending without replaying it. */
  readonly showLeft: () => void;
  /** The interviewer's reply to leaving: its sign-off. */
  readonly onLeft: (turn: PortalTurn) => void;
}

export const LEAVE_FAILED = "We couldn't end the interview — try again.";

/**
 * Refusals meaning the interview is past accepting anything — ended from
 * another tab, or at its length limit. Retrying Leave can only meet them
 * again, so the room reads where things stand instead.
 */
function nothingLeftToLeave(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 429 || (e.status === 409 && /no longer accepting answers/i.test(e.message)));
}

/**
 * Leaving the interview. It is sent as the Leave action — the server records
 * it as one and withdraws the interview unassessed — not as words the
 * candidate said, and it is not tied to the question on screen.
 *
 * Once the interviewer has signed off there is nothing left to leave: the
 * interview is finalised, and "leaving" then would only meet a refusal and
 * replace the real ending (transcript, feedback question) with a short one.
 */
export function useLeave(deps: LeaveDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const available = (live: boolean) => live && !depsRef.current.currentTurnDone();

  /** Leaving did not happen: carry on exactly where the candidate was. */
  const carryOn = (message: string) => {
    const d = depsRef.current;
    d.setErr(message);
    d.clearReveal();
    d.setPhase('listening');
    const midAnswer = d.answerInProgress();
    if (midAnswer) d.reopenAnswer();
    if (d.pausedRef.current) return;
    // Mid-answer, the same answer continues; if Leave cut the question off
    // before it was answered, the answer starts now.
    if (midAnswer) void d.beginListening({ resume: true });
    else void d.beginListening({});
  };

  /** The interview is no longer live: show how it ended rather than retry. */
  const settle = async () => {
    const d = depsRef.current;
    try {
      await api.post(`/portal/${d.token}/start`, {});
      d.showLeft();
    } catch (e: unknown) {
      if (refusalOf(e) === 'finished') d.showFinished();
      else d.showLeft();
    }
  };

  const leave = async (): Promise<void> => {
    const d = depsRef.current;
    if (d.currentTurnDone()) return;
    d.stopSpeech();
    // Held, not discarded: if leaving fails, the answer carries on intact.
    await d.holdCapture();
    d.setPhase('thinking');
    let turn: PortalTurn;
    try {
      turn = (await api.post<{ turn: PortalTurn }>(`/portal/${d.token}/turn`, {
        text: LEAVE_MARKER, leaving: true, inReplyTo: undefined,
      })).turn;
    } catch (e: unknown) {
      if (refusalOf(e) === 'finished') { d.showFinished(); return; }
      if (nothingLeftToLeave(e)) { await settle(); return; }
      // Nothing about their draft changes: this is not "your answer was not sent".
      carryOn(LEAVE_FAILED);
      return;
    }
    // Only the ending counts as having left. Anything else (another tab's
    // reply winning a race) means this Leave did not take.
    if (!turn.done) { carryOn(LEAVE_FAILED); return; }
    d.onLeft(turn);
  };

  return { available, leave };
}
