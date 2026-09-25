import { useCallback, useEffect, useRef } from 'react';
import {
  createRecognizer, speakNudge, startRecording, transcribeOnServer,
  type Recognizer, type Recording,
} from '../../speech';
import { recognitionLang } from '../../speechLang';
import {
  NOTHING_HELD, answerFromHeld, heldText, holdSegment, untranscribed, type HeldAnswer,
} from './roomComposerModel';
import type { RoomPhase } from './roomConversationModel';
import { listensByVoice } from '../portalConsentModel';

/**
 * A spoken answer, from opening the microphone to handing over text.
 *
 * Browser recognition is preferred (no upload, no cost); a local recording is
 * kept alongside it and transcribed on the server when recognition fails. Only
 * the candidate ends their turn — silence brings a check-in, never a submit.
 * Every path that stops listening (pause, check-in, repeat, switching to
 * typing, a dead microphone) keeps what was said: nothing is dropped.
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
  /** The interviewer's browser-voice hint, for a check-in spoken without a server voice. */
  readonly voiceHintRef?: { readonly current: string | undefined };
  /** The session's language ('en', 'en-GB', …), for the language the recognizer listens in. */
  readonly languageRef?: { readonly current: string | undefined };
  readonly setPhase: (phase: RoomPhase) => void;
  readonly setTextMode: (textMode: boolean) => void;
  readonly setInterim: (text: string) => void;
  readonly setErr: (message: string) => void;
  readonly submitAnswer: (text: string) => void;
  readonly addNudge: (text: string) => void;
  /** Add words to the typed draft, after whatever is already there. */
  readonly mergeIntoDraft: (text: string) => void;
  /** Capture broke for good: the room stops showing the microphone as open. */
  readonly onMicDead: () => void;
  /** The microphone is capturing again, so the capture indicator must show it. */
  readonly onCaptureStarted?: () => void;
}

export function useVoiceAnswer(deps: VoiceAnswerDeps) {
  // Read through a ref so the callbacks below stay stable across renders while
  // always seeing the room's latest functions.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const recognizerRef = useRef<Recognizer | null>(null);
  const recordingRef = useRef<Recording | null>(null);
  const recognizerFailedRef = useRef(false);
  // Whether the capture under way has words we cannot trust to the browser:
  // its recognizer failed, or there was none. Only then is a wordless
  // recording sent to the server — otherwise no words means nothing was said
  // (a pause), and transcribing silence would only use up the hourly limit.
  const needsServerRef = useRef(false);
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
  // Typed words carried into a spoken answer before its turn opened.
  const carriedRef = useRef('');
  // From the moment the candidate may answer until the answer is closed or
  // the next question arrives — including through a check-in, when nothing
  // is listening but the answer is very much still in progress.
  const answerOpenRef = useRef(false);
  // Every start or stop of listening takes a new generation. Opening the mic
  // is asynchronous, and a start that finishes after a later stop (or after
  // the room has gone) must not leave a recorder or recognizer running.
  const generationRef = useRef(0);
  const unmountedRef = useRef(false);

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

  /** Pause capture mid-answer, keeping what was heard (words and audio). */
  const holdCapture = useCallback(async (): Promise<void> => {
    generationRef.current += 1;
    const heard = detachRecognizer();
    const recording = recordingRef.current;
    recordingRef.current = null;
    const audio = recording ? await recording.stop() : null;
    // Audio is kept only where there are no words for it: the words are the
    // answer, and the audio is the fallback for when recognition failed.
    heldRef.current = holdSegment(heldRef.current, heard, keepAudio(heard, audio));
  }, [detachRecognizer]);

  /** A recording is kept only for words the browser could not give us. */
  function keepAudio(heard: string, audio: Blob | null): Blob | null {
    return !heard.trim() && needsServerRef.current ? audio : null;
  }

  /** Turn every wordless held segment into words, in place. */
  const transcribeHeld = useCallback(async (held: HeldAnswer): Promise<{ text: string; failed: boolean }> => {
    const missing = untranscribed(held);
    if (missing.length === 0) return { text: answerFromHeld(held, new Map()), failed: false };
    // One upload at a time: each counts against the portal's hourly
    // transcription limit, and a burst of them can use it up in one answer.
    const transcripts = new Map<number, string>();
    for (const i of missing) {
      try {
        const text = (await transcribeOnServer(depsRef.current.token, held.segments[i].audio as Blob)) ?? '';
        if (text.trim()) transcripts.set(i, text);
      } catch {
        // Counted as failed below; the candidate is told.
      }
    }
    return { text: answerFromHeld(held, transcripts), failed: transcripts.size < missing.length };
  }, []);

  /**
   * Stop listening and give everything said so far to the typed draft — the
   * candidate switched to typing, or the microphone died. Audio the recognizer
   * never turned into words is transcribed first; if that fails, they are told.
   */
  const releaseToTyping = useCallback(async (): Promise<void> => {
    clearWatchdog();
    await holdCapture();
    const held = heldRef.current;
    heldRef.current = NOTHING_HELD;
    const { text, failed } = await transcribeHeld(held);
    if (text) depsRef.current.mergeIntoDraft(text);
    if (failed) depsRef.current.setErr('We could not turn what you said into text — please type that part of your answer.');
  }, [clearWatchdog, holdCapture, transcribeHeld]);

  /** Drop the answer in progress (the interview is ending), returning any words heard. */
  const discardCapture = useCallback((): string => {
    generationRef.current += 1;
    const heard = joinHeld(heldRef.current, detachRecognizer());
    void recordingRef.current?.stop();
    recordingRef.current = null;
    heldRef.current = NOTHING_HELD;
    answerOpenRef.current = false;
    clearWatchdog();
    return heard;
  }, [detachRecognizer, clearWatchdog]);

  /**
   * Typed words the candidate switched away from, carried into the spoken
   * answer so they are sent with it rather than hidden and later erased.
   */
  const carryIn = useCallback((text: string) => {
    if (!text.trim()) return;
    if (answerOpenRef.current) {
      heldRef.current = holdSegment(heldRef.current, text, null);
      depsRef.current.setInterim(heldText(heldRef.current));
    } else {
      carriedRef.current = [carriedRef.current, text].join(' ').trim();
    }
  }, []);

  /**
   * Turn "the candidate stopped talking" into text, from whichever source
   * actually produced any.
   */
  const finishAnswer = useCallback(async (recognised: string) => {
    const d = depsRef.current;
    const rec = recordingRef.current;
    recordingRef.current = null;
    const audio = rec ? await rec.stop() : null;
    const held = holdSegment(heldRef.current, recognised, keepAudio(recognised, audio));
    heldRef.current = NOTHING_HELD;

    const needsServer = untranscribed(held).length > 0;
    if (needsServer) {
      d.setPhase('thinking');
      d.setInterim('Transcribing your answer…');
    }
    const { text, failed } = await transcribeHeld(held);
    if (needsServer) d.setInterim('');
    if (text && !failed) {
      recognizerFailedRef.current = false;
      answerOpenRef.current = false;
      d.submitAnswer(text);
      return;
    }
    turnClosedRef.current = false;
    d.setPhase('listening');
    if (text) {
      // Part of the answer could not be turned into words. Sending the rest
      // would pass off half an answer as the whole of it; the candidate gets
      // what was heard in the box and is asked to add the missing part.
      d.setTextMode(true);
      d.mergeIntoDraft(text);
      d.setErr('We could not turn what you said into text — please type that part of your answer.');
      return;
    }
    if (needsServer) {
      // A failed transcription once left the room on "Transcribing your
      // answer…" for good, with nobody listening.
      d.setTextMode(true);
      d.setErr('We could not transcribe that just now. Nothing you have said is lost — please type this answer below.');
      return;
    }
    // Nothing usable from either path. The turn did NOT close — reopen it, or
    // the candidate is told to try again by a screen that will ignore them.
    d.setErr(recognizerFailedRef.current
      ? 'We could not hear that. Please try again, or type your answer instead.'
      : 'No speech detected. Please try again, or type your answer instead.');
    // Listening again, so "please try again" is something they can do.
    void beginListeningRef.current({ resume: true });
  }, [transcribeHeld]);

  /** Close the turn exactly once, whichever path got here first. */
  const closeTurn = useCallback((text: string) => {
    if (turnClosedRef.current) return;
    turnClosedRef.current = true;
    // Its words are in `text` now; left attached, a later start would fold
    // them into the answer a second time.
    recognizerRef.current = null;
    clearWatchdog();
    void finishAnswer(text);
  }, [clearWatchdog, finishAnswer]);

  // Declared before use by the recognizer's handlers; assigned below.
  const beginListeningRef = useRef<(opts?: { resume?: boolean }) => Promise<void>>(async () => undefined);
  const checkInRef = useRef<() => Promise<void>>(async () => undefined);
  const micDeadRef = useRef<() => void>(() => undefined);

  const beginListening = useCallback(async (opts: { resume?: boolean } = {}) => {
    const d = depsRef.current;
    const generation = ++generationRef.current;
    // When this turn's answer actually started, for the evidence timestamps.
    // A resumed answer (after a pause, check-in or repeat) keeps its start.
    if (!opts.resume) {
      turnStartRef.current = Date.now();
      heldRef.current = NOTHING_HELD;
      silenceCountRef.current = 0;
    }
    // Typed words carried in before listening started join the answer on
    // every start, resumed or not — they must never wait for a later one.
    if (carriedRef.current) {
      heldRef.current = holdSegment(heldRef.current, carriedRef.current, null);
      carriedRef.current = '';
    }
    answerOpenRef.current = true;
    turnClosedRef.current = false;
    if (!listensByVoice({ textMode: d.textModeRef.current, canCapture: d.canCaptureRef.current })) {
      // Without consent to capture, the keyboard is the only way to answer.
      if (!d.canCaptureRef.current && !d.textModeRef.current) d.setTextMode(true);
      // Anything held for a spoken answer belongs in the box now.
      const held = heldText(heldRef.current);
      heldRef.current = NOTHING_HELD;
      if (held) d.mergeIntoDraft(held);
      d.setPhase('listening');
      return;
    }
    d.setInterim(heldText(heldRef.current));
    d.setPhase('listening');

    // Always record. The recording is what gets transcribed if the browser's
    // own recognition fails — without it a `network` error loses the answer.
    // Checked again at the call itself: nothing may open the microphone for a
    // candidate who declined voice capture, whatever path led here.
    const recording = d.canCaptureRef.current ? await startRecording() : null;
    // Paused, switched to typing, superseded by a newer start, or the room
    // closed while the mic was opening: this start no longer applies.
    const stillWanted = !unmountedRef.current && generation === generationRef.current
      && d.phaseRef.current === 'listening' && !d.textModeRef.current && !d.pausedRef.current && !turnClosedRef.current;
    if (!stillWanted) { void recording?.stop(); return; }
    // Anything still live from an earlier start is folded into the answer
    // before it is replaced, so two captures never run at once.
    const earlier = detachRecognizer();
    if (earlier) heldRef.current = holdSegment(heldRef.current, earlier, null);
    void recordingRef.current?.stop();
    recordingRef.current = recording;
    if (recording) d.onCaptureStarted?.();

    // Only the current recognizer speaks for the answer: a detached one still
    // fires its events.
    needsServerRef.current = false;
    const rec: Recognizer | null = createRecognizer({
      onInterim: (t) => { if (recognizerRef.current === rec) d.setInterim(joinHeld(heldRef.current, t)); },
      onFinal: (t) => { if (recognizerRef.current === rec) closeTurn(t); },
      onError: (e) => {
        if (e === 'no-speech' || recognizerRef.current !== rec) return;
        // Not an error yet: if we captured audio, the server can still
        // transcribe it and the candidate never needs to know.
        recognizerFailedRef.current = true;
        needsServerRef.current = true;
        if (!recordingRef.current) d.setErr(`Speech error: ${e}. You can type your answer instead.`);
      },
      // Long silence: the interviewer checks in, as a person would. The turn
      // is NOT closed and nothing is submitted.
      onSilence: () => { if (recognizerRef.current === rec) void checkInRef.current(); },
      // Capture is broken and will not recover.
      onDead: () => { if (recognizerRef.current === rec) micDeadRef.current(); },
    }, { lang: recognitionLang(d.languageRef?.current, typeof navigator === 'undefined' ? [] : navigator.languages ?? []) });
    if (!rec) {
      needsServerRef.current = true;
      // No browser recognition at all. Recording alone still works if the
      // server can transcribe; otherwise fall back to typing.
      if (!recordingRef.current) { d.setTextMode(true); d.setPhase('listening'); }
      return;
    }
    recognizerRef.current = rec;
    rec.start();
    d.onCaptureStarted?.();
  }, [closeTurn, detachRecognizer]);
  beginListeningRef.current = beginListening;

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
    const said = await speakNudge(d.token, n, d.voiceHintRef?.current);
    if (unmountedRef.current) return;
    if (said) d.addNudge(said);
    // They may have finished, paused or asked for a repeat meanwhile.
    if (turnClosedRef.current || seq !== d.speechSeqRef.current) return;
    d.setPhase('listening');
    if (!d.pausedRef.current) void beginListening({ resume: true });
  };

  /**
   * The microphone died: offer the keyboard at once, with everything said so
   * far already in the box — "nothing you have said is lost" has to be true.
   */
  micDeadRef.current = () => {
    const d = depsRef.current;
    recognizerFailedRef.current = true;
    needsServerRef.current = true;
    d.setTextMode(true);
    d.onMicDead();
    d.setErr('Your microphone stopped working. Please type your answer below — nothing you have said so far is lost.');
    void releaseToTyping();
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

  /** Whether the candidate has an answer under way (it survives a check-in or a pause). */
  const answerInProgress = useCallback(() => answerOpenRef.current && !turnClosedRef.current, []);

  /** A new question: the previous answer, if any, is over. */
  const endAnswer = useCallback(() => { answerOpenRef.current = false; }, []);

  /** A send failed: the answer is open again, so switching modes keeps adding to it. */
  const reopenAnswer = useCallback(() => {
    answerOpenRef.current = true;
    turnClosedRef.current = false;
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      // Detached first, so the aborted recognizer cannot post a partial answer
      // after the candidate has navigated away; and the recorder is released.
      unmountedRef.current = true;
      generationRef.current += 1;
      detachRecognizer();
      void recordingRef.current?.stop();
      recordingRef.current = null;
      // Otherwise a pending watchdog fires after unmount and sets state on a
      // component that is gone.
      if (doneWatchdogRef.current !== null) window.clearTimeout(doneWatchdogRef.current);
    };
  }, [detachRecognizer]);

  return {
    turnStartRef, turnClosedRef,
    beginListening, holdCapture, releaseToTyping, discardCapture, carryIn, detachRecognizer,
    doneAnswering, answerInProgress, endAnswer, reopenAnswer,
  };
}

function joinHeld(held: HeldAnswer, live: string): string {
  return [heldText(held), live].join(' ').replace(/\s+/g, ' ').trim();
}
