import { useEffect, useRef } from 'react';
import { api, ApiError } from '../../api/client';
import {
  REPLY_POLL_INTERVAL_MS, keepWaitingForReply, roomOpening, roomRefusal,
  type RoomRefusal, type StartResponse, type StartedTurn,
} from '../roomResumeModel';

/**
 * Opening the room from a start response — fresh, or a rejoin mid-interview —
 * and the recoveries that go with a rejoin: waiting for a reply that is still
 * being produced, Continue, and an answer aimed at a question the interview
 * has already moved past. The rules live in roomResumeModel; this is the
 * wiring to the room.
 */

export interface RejoinDeps {
  readonly token: string;
  /** Show the conversation the room opens on, and set the clock back by `clockOffsetMs`. */
  readonly openOn: (res: StartResponse, messages: ReturnType<typeof roomOpening>['messages'], clockOffsetMs: number) => void;
  readonly setAwaitingReply: (awaiting: boolean) => void;
  /** Put a question up as the one the next answer replies to, without speaking it. */
  readonly showQuestion: (turn: StartedTurn, prefix: string, questionText: string) => void;
  readonly sayAndListen: (turn: StartedTurn, prefix: string) => void;
  readonly beginListening: () => void;
  readonly thinking: () => void;
  readonly showFinished: () => void;
  /** An answer could not be sent; keep its text in the box. */
  readonly keepAnswer: (text: string) => void;
  readonly setErr: (message: string) => void;
  readonly reopenTurn: () => void;
  /** Stop listening for the answer in progress, for Continue. */
  readonly stopAnswering: () => void;
  /** A new interviewer turn: into the conversation, then spoken. */
  readonly receiveTurn: (turn: StartedTurn) => void;
  readonly currentTurnId: () => string | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** How a refused request should be handled, from what the server said. */
export function refusalOf(e: unknown): RoomRefusal {
  return roomRefusal(e instanceof ApiError ? e.status : undefined, e instanceof ApiError ? e.code : undefined, errorMessage(e));
}

export function useRejoin(deps: RejoinDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  // Stops the wait-for-reply loop once the room is gone.
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  function applyOpening(res: StartResponse, allowWait = true): void {
    const d = depsRef.current;
    const opening = roomOpening(res, { allowWait });
    d.openOn(res, opening.messages, opening.clockOffsetMs);
    d.setAwaitingReply(opening.mode !== 'speak');
    if (opening.mode === 'wait') {
      // Only "picking up" shows: the question beside it has been answered, and
      // the reply is the next thing to show.
      d.showQuestion(opening.turn, opening.captionPrefix, '');
      d.thinking();
      void waitForReply();
      return;
    }
    if (opening.mode === 'listen') {
      d.showQuestion(opening.turn, opening.captionPrefix, opening.turn.text);
      d.beginListening();
      return;
    }
    d.sayAndListen(opening.turn, opening.captionPrefix);
  }

  /**
   * The answer went in moments before the rejoin, so its reply is most likely
   * still being produced. Re-read until it lands rather than invite the
   * candidate to answer a question they already answered; after the budget,
   * offer Continue instead.
   */
  async function waitForReply(): Promise<void> {
    const began = Date.now();
    let latest: StartResponse | null = null;
    while (keepWaitingForReply(Date.now() - began)) {
      await new Promise((resolve) => window.setTimeout(resolve, REPLY_POLL_INTERVAL_MS));
      if (unmountedRef.current) return;
      try {
        latest = await api.post<StartResponse>(`/portal/${depsRef.current.token}/start`, {});
      } catch (e: unknown) {
        if (refusalOf(e) === 'finished') { depsRef.current.showFinished(); return; }
        continue;
      }
      if (!latest.awaitingReply) { applyOpening(latest); return; }
    }
    if (latest) { applyOpening(latest, false); return; }
    depsRef.current.setAwaitingReply(true);
    depsRef.current.beginListening();
  }

  /**
   * The answer was aimed at a question the interview had already moved past —
   * another tab, or a reply that landed during a reload. Nothing was recorded;
   * put the current question up and keep what they wrote.
   */
  async function catchUpAfterStale(keptText: string): Promise<void> {
    const d = depsRef.current;
    d.keepAnswer(keptText);
    try {
      const res = await api.post<StartResponse>(`/portal/${d.token}/start`, {});
      applyOpening(res);
      d.setErr('The interview had already moved on to a newer question, so that answer was not sent. It is still in the box below — edit it or send it as it is.');
    } catch (e: unknown) {
      if (refusalOf(e) === 'finished') { d.showFinished(); return; }
      d.reopenTurn();
      d.setErr(`${errorMessage(e)} — your answer was not sent. It is in the box below; press Send to try again.`);
    }
  }

  /** Nothing to add to the saved answer: ask for the reply to it. */
  async function continueInterview(): Promise<void> {
    const d = depsRef.current;
    d.stopAnswering();
    d.setErr('');
    d.thinking();
    try {
      const res = await api.post<{ turn: StartedTurn }>(`/portal/${d.token}/continue`, {});
      d.setAwaitingReply(false);
      // The server hands back the pending question if a reply already existed;
      // only a question not yet on screen joins the transcript.
      if (res.turn.turnId !== d.currentTurnId()) d.receiveTurn(res.turn);
      else d.sayAndListen(res.turn, '');
    } catch (e: unknown) {
      if (refusalOf(e) === 'finished') { d.showFinished(); return; }
      d.setErr(`${errorMessage(e)} Please try again.`);
      d.beginListening();
    }
  }

  return { applyOpening, catchUpAfterStale, continueInterview };
}
