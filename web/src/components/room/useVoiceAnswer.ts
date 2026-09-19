import { useCallback, useEffect, useRef } from 'react';
import {
  createRecognizer, speakNudge, startRecording, transcribeOnServer,
  type Recognizer, type Recording,
} from '../../speech';
import { NOTHING_HELD, joinAnswer, type HeldAnswer } from './roomComposerModel';
import type { RoomPhase } from './roomConversationModel';
import { listensByVoice } from '../portalConsentModel';

/**
 * A spoken answer, from opening the microphone to handing over text.
 *
 * Browser recognition is preferred (no upload, no cost); a local recording is
 * kept alongside it and transcribed on the server when recognition fails. Only
 * the candidate ends their turn — silence brings a check-in, never a submit.
 */

export interface VoiceAnswerDeps {
  readonly token: string;
  readonly phaseRef: { readonly current: RoomPhase };
  readonly textModeRef: { readonly current: boolean };
  /** Whether the candidate agreed to voice capture, read at the moment of listening. */
  readonly canCaptureRef: { readonly current: boolean };
  readonly pausedRef: { readonly current: boolean };
  /** Bumped by the room whenever speech is replaced; a check-in that loses the race stands down. */
  readonly speechSeqRef: { current: number };
  readonly setPhase: (phase: RoomPhase) => void;
  readonly setTextMode: (textMode: boolean) => void;
  readonly setInterim: (text: string) => void;
  readonly setErr: (message: string) => void;
  readonly submitAnswer: (text: string) => void;
  readonly addNudge: (text: string) => void;
}

export function useVoiceAnswer(deps: VoiceAnswerDeps) {
  // Read through a ref so the callbacks below stay stable across renders while
  // always seeing the room's latest functions.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const recognizerRef = useRef<Recognizer | null>(null);
  const recordingRef = useRef<Recording | null>(null);
  const recognizerFailedRef = useRef(false);
  // When the candidate was first able to answer the current question.
  const turnStartRef = useRef(0);
  // One answer per turn. The recognizer's end event and the "Done answering"
  // watchdog can both fire for the same answer, and without this the candidate
  // submits twice — the second one empty, which reads as a non-answer.
  const turnClosedRef = useRef(false);
  const doneWatchdogRef = useRef<number | null>(null);
  // Escalates the check-in wording within a turn, and resets with the turn so
  // the next question starts from the gentlest phrasing again.
  const silenceCountRef = useRef(0);
  // Speech heard before a pause, check-in or repeat interrupted the answer.
  const heldRef = useRef<HeldAnswer>(NOTHING_HELD);

  const clearWatchdog = useCallback(() => {
    if (doneWatchdogRef.current !== null) {
      window.clearTimeout(doneWatchdogRef.current);
      doneWatchdogRef.current = null;
    }
  }, []);

  /**
   * Stop the recognizer without letting it answer. It is detached BEFORE it
   * is aborted: an aborted recognizer still reports its text as final, and
   * letting that through submitted half an answer. Returns what it had heard.
   */
  const detachRecognizer = useCallback((): string => {
    const rec = recognizerRef.current;
    recognizerRef.current = null;
    const heard = rec?.text() ?? '';
    rec?.abort();
    return heard;
  }, []);

  /** Pause capture mid-answer, keeping what was heard (text and audio). */
  const holdCapture = useCallback(async (): Promise<void> => {
    const heard = detachRecognizer();
    const recording = recordingRef.current;
    recordingRef.current = null;
    const audio = recording ? await recording.stop() : null;
    const held = heldRef.current;
    heldRef.current = { text: joinAnswer(held.text, heard), audio: audio ? [...held.audio, audio] : held.audio };
  }, [detachRecognizer]);

  /** Drop the answer in progress entirely, returning any text heard so far. */
  const discardCapture = useCallback((): string => {
    const heard = joinAnswer(heldRef.current.text, detachRecognizer());
    void recordingRef.current?.stop();
    recordingRef.current = null;
    heldRef.current = NOTHING_HELD;
    clearWatchdog();
    return heard;
  }, [detachRecognizer, clearWatchdog]);

  /**
   * Turn "the candidate stopped talking" into text, from whichever source
   * actually produced any.
   */
  const finishAnswer = useCallback(async (recognised: string) => {
    const d = depsRef.current;
    const rec = recordingRef.current;
    recordingRef.current = null;
    const audio = rec ? await rec.stop() : null;
    const held = heldRef.current;
    heldRef.current = NOTHING_HELD;

    const said = joinAnswer(held.text, recognised);
    if (said) { d.submitAnswer(said); return; }

    const clips = audio ? [...held.audio, audio] : held.audio;
    if (clips.length) {
      d.setPhase('thinking');
      d.setInterim('Transcribing your answer…');
      try {
        const parts = await Promise.all(clips.map((clip) => transcribeOnServer(d.token, clip)));
        const text = joinAnswer(...parts.map((p) => p ?? ''));
        if (text) { d.setInterim(''); recognizerFailedRef.current = false; d.submitAnswer(text); return; }
      } catch {
        // Falls through: a failed transcription once left the room on
        // "Transcribing your answer…" for good, with nobody listening.
      }
      d.setInterim('');
      turnClosedRef.current = false;
      d.setTextMode(true);
      d.setPhase('listening');
      d.setErr('We could not transcribe that just now. Nothing you have said is lost — please type this answer below.');
      return;
    }

    // Nothing usable from either path. The turn did NOT close — reopen it, or
    // the candidate is told to try again by a screen that will ignore them.
    turnClosedRef.current = false;
    d.setPhase('listening');
    d.setErr(recognizerFailedRef.current
      ? 'We could not hear that. Please try again, or type your answer instead.'
      : 'No speech detected. Please try again, or type your answer instead.');
  }, []);

  /** Close the turn exactly once, whichever path got here first. */
  const closeTurn = useCallback((text: string) => {
    if (turnClosedRef.current) return;
    turnClosedRef.current = true;
    clearWatchdog();
    void finishAnswer(text);
  }, [clearWatchdog, finishAnswer]);

  // Declared before use by the recognizer's silence handler; assigned below.
  const checkInRef = useRef<() => Promise<void>>(async () => undefined);

  const beginListening = useCallback(async (opts: { resume?: boolean } = {}) => {
    const d = depsRef.current;
    // When this turn's answer actually started, for the evidence timestamps.
    // A resumed answer (after a pause, check-in or repeat) keeps its start.
    if (!opts.resume) {
      turnStartRef.current = Date.now();
      heldRef.current = NOTHING_HELD;
      silenceCountRef.current = 0;
    }
    turnClosedRef.current = false;
    if (!listensByVoice({ textMode: d.textModeRef.current, canCapture: d.canCaptureRef.current })) {
      // Without consent to capture, the keyboard is the only way to answer.
      if (!d.canCaptureRef.current && !d.textModeRef.current) d.setTextMode(true);
      d.setPhase('listening');
      return;
    }
    d.setInterim(heldRef.current.text);
    d.setPhase('listening');

    // Always record. The recording is what gets transcribed if the browser's
    // own recognition fails — without it a `network` error loses the answer.
    // Checked again at the call itself: nothing may open the microphone for a
    // candidate who declined voice capture, whatever path led here.
    const recording = d.canCaptureRef.current ? await startRecording() : null;
    // They may have paused or switched to typing while the mic was opening.
    if (d.textModeRef.current || d.pausedRef.current || turnClosedRef.current) { void recording?.stop(); return; }
    recordingRef.current = recording;

    // Only the current recognizer speaks for the answer: a detached one still
    // fires its events.
    const rec: Recognizer | null = createRecognizer({
      onInterim: (t) => { if (recognizerRef.current === rec) d.setInterim(joinAnswer(heldRef.current.text, t)); },
      onFinal: (t) => { if (recognizerRef.current === rec) closeTurn(t); },
      onError: (e) => {
        if (e === 'no-speech' || recognizerRef.current !== rec) return;
        // Not an error yet: if we captured audio, the server can still
        // transcribe it and the candidate never needs to know.
        recognizerFailedRef.current = true;
        if (!recordingRef.current) d.setErr(`Speech error: ${e}. You can type your answer instead.`);
      },
      // Long silence: the interviewer checks in, as a person would. The turn
      // is NOT closed and nothing is submitted.
      onSilence: () => { if (recognizerRef.current === rec) void checkInRef.current(); },
      // Capture is broken and will not recover. Offer the keyboard at once.
      onDead: () => {
        if (recognizerRef.current !== rec) return;
        recognizerFailedRef.current = true;
        d.setTextMode(true);
        d.setErr('Your microphone stopped working. Please type your answer below — nothing you have said so far is lost.');
      },
    });
    if (!rec) {
      // No browser recognition at all. Recording alone still works if the
      // server can transcribe; otherwise fall back to typing.
      if (!recordingRef.current) { d.setTextMode(true); d.setPhase('listening'); }
      return;
    }
    recognizerRef.current = rec;
    rec.start();
  }, [closeTurn]);

  /**
   * The check-in after a long silence. Capture is held while the interviewer
   * speaks, or the microphone would transcribe its words into the answer.
   */
  checkInRef.current = async () => {
    const d = depsRef.current;
    if (turnClosedRef.current) return;
    const n = Math.min(silenceCountRef.current, 2);
    silenceCountRef.current += 1;
    d.speechSeqRef.current += 1;
    const seq = d.speechSeqRef.current;
    await holdCapture();
    d.setPhase('speaking');
    const said = await speakNudge(d.token, n);
    if (said) d.addNudge(said);
    // They may have finished, paused or asked for a repeat meanwhile.
    if (turnClosedRef.current || seq !== d.speechSeqRef.current) return;
    d.setPhase('listening');
    if (!d.pausedRef.current) void beginListening({ resume: true });
  };

  /**
   * "Done answering". The text is read off the recognizer when the watchdog
   * fires, not at the click — Chrome often finalises a trailing phrase in
   * between — and the watchdog covers an end event that never arrives.
   */
  const doneAnswering = useCallback(() => {
    // Repeated presses must not each install a watchdog.
    if (turnClosedRef.current || doneWatchdogRef.current !== null) return;
    const rec = recognizerRef.current;
    if (!rec) { closeTurn(''); return; }
    depsRef.current.setPhase('thinking');
    doneWatchdogRef.current = window.setTimeout(() => closeTurn(rec.text()), 1500);
    rec.stop();
  }, [closeTurn]);

  useEffect(() => () => {
    recognizerRef.current?.abort();
    void recordingRef.current?.stop();
    // Otherwise a pending watchdog fires after unmount and sets state on a
    // component that is gone.
    if (doneWatchdogRef.current !== null) window.clearTimeout(doneWatchdogRef.current);
  }, []);

  return {
    turnStartRef, turnClosedRef, doneWatchdogRef,
    beginListening, holdCapture, discardCapture, detachRecognizer, doneAnswering, clearWatchdog,
  };
}
