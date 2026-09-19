import { useRef } from 'react';
import { api } from '../../api/client';
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
  readonly holdCapture: () => Promise<void>;
  readonly beginListening: (opts: { resume?: boolean }) => Promise<void>;
  readonly stopSpeech: () => void;
  readonly setPhase: (phase: 'listening' | 'thinking') => void;
  readonly setErr: (message: string) => void;
  readonly showFinished: () => void;
  /** The interviewer's reply to leaving: its sign-off. */
  readonly onLeft: (turn: PortalTurn) => void;
}

export const LEAVE_FAILED = "We couldn't end the interview — try again.";

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

  const leave = async (): Promise<void> => {
    const d = depsRef.current;
    if (d.currentTurnDone()) return;
    d.stopSpeech();
    // Held, not discarded: if leaving fails, the answer carries on intact.
    await d.holdCapture();
    d.setPhase('thinking');
    try {
      const res = await api.post<{ turn: PortalTurn }>(`/portal/${d.token}/turn`, {
        text: LEAVE_MARKER, leaving: true, inReplyTo: undefined,
      });
      d.onLeft(res.turn);
    } catch (e: unknown) {
      if (refusalOf(e) === 'finished') { d.showFinished(); return; }
      // Nothing about their draft changes: this is not "your answer was not sent".
      d.setErr(LEAVE_FAILED);
      d.setPhase('listening');
      if (!d.textModeRef.current && !d.pausedRef.current) void d.beginListening({ resume: true });
    }
  };

  return { available, leave };
}
