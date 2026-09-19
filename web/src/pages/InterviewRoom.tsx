import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import {
  speakTurn, speakNudge, stopAllSpeech, createRecognizer, createMicMeter,
  startRecording, transcribeOnServer,
  sttSupported, ttsSupported, type Recognizer, type MicMeter, type Recording,
} from '../speech';
import { VoiceHandling, transcriptionProcessorSentence, type SttCapability } from './Portal';
import { Icon } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';
import { interviewerName } from '../components/candidateJourney';
import { interviewRoomHeader } from '../components/interviewerModel';
import { listensByVoice, shouldCaptureAudio } from '../components/portalConsentModel';
import {
  REPLY_POLL_INTERVAL_MS, keepWaitingForReply, roomOpening, roomRefusal, type StartResponse,
} from '../components/roomResumeModel';
import { FINISHED_ENTRY } from '../components/portalEntryModel';
import {
  FEEDBACK_EXPLANATION, FEEDBACK_NO_LABEL, FEEDBACK_QUESTION, FEEDBACK_YES_LABEL, answerConfirmation,
} from '../components/feedbackOptInCopy';

// The interview room is the only screen a candidate ever sees, and it is the
// screen they judge the company by. It is deliberately built as a call surface
// — a stage with participants and a control bar — rather than as stacked cards:
// people already know how to be interviewed over a video call, and borrowing
// that grammar means nobody has to learn a new UI while also being assessed.

/** A turn as the portal sends it to the room: only what the room uses. */
interface AgentTurn { turnId: string; text: string; done: boolean }
interface Msg { speaker: 'agent' | 'candidate'; text: string }
interface PortalInfo {
  candidateName: string; roleTitle: string; durationMinutes: number;
  /** Who conducts this interview; absent on an older server. voiceHint picks the browser voice when there is no server voice; never a provider voice id. */
  persona?: { name: string | null; interviewerId?: string | null; voiceHint?: string } | null;
  recordingConsented?: boolean;
  speech: { stt: SttCapability };
  proctoringEnabled: boolean;
  // Whether to put the written-feedback question at the end, and the answer if
  // one is already on file. `offered` is false when this tenant has candidate
  // feedback switched off — offering something we cannot deliver would be worse
  // than not asking.
  feedbackOptIn?: { offered: boolean; choice: string | null };
}
type Phase = 'ready' | 'speaking' | 'listening' | 'thinking' | 'done';

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || 'Y';

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!since) return <span>00:00</span>;
  const s = Math.floor((Date.now() - since) / 1000);
  return <span>{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** Concentric rings that breathe while a participant is active. */
function SpeakingRings({ active, level }: { active: boolean; level: number }) {
  const scale = 1 + (active ? Math.max(0.06, level) * 0.5 : 0);
  return (
    <>
      <span className="tile-ring" style={{ transform: `scale(${scale})`, opacity: active ? 0.35 : 0 }} />
      <span className="tile-ring delayed" style={{ transform: `scale(${scale * 1.15})`, opacity: active ? 0.18 : 0 }} />
    </>
  );
}

/**
 * What the room bar is allowed to claim about the microphone.
 *
 * This replaces a red "REC" pill, which was a straightforward lie: nothing is
 * recorded. No audio file is written, kept or playable — the transcript is the
 * artefact (docs/BUILD_STATUS.md), and the server discards each uploaded clip
 * the moment the text comes back.
 *
 * Deleting the pill outright would have been the other kind of dishonesty. The
 * microphone genuinely is open and the audio genuinely does leave the machine
 * for a third-party transcriber, so an unmarked interview would understate what
 * is happening. The indicator stays, keeps its pulsing dot — capture is live and
 * should look live — and now says what the capture is FOR.
 *
 * 'transcribing' — audio is being captured and turned into text.
 * 'mic'          — the mic is open for the level meter only (typed answers), so
 *                  nothing is being transcribed and it must not claim otherwise.
 */
function CaptureIndicator({ mode, stt }: { mode: 'transcribing' | 'mic'; stt: SttCapability }) {
  const detail = mode === 'transcribing'
    ? `Your voice is captured while you answer and transcribed to text. ${transcriptionProcessorSentence(stt)} `
      + 'No audio file is stored — the written transcript is what is kept and reviewed.'
    : 'Your microphone is open so the level meter can show you it is working. You are answering by '
      + 'typing, so no audio is being transcribed and none is stored.';
  return (
    <span className="rec-pill" title={detail}>
      <i />{mode === 'transcribing' ? 'LIVE TRANSCRIPTION' : 'MIC OPEN'}
    </span>
  );
}

export function InterviewRoom() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<PortalInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [currentAgent, setCurrentAgent] = useState('');
  const [currentTurnId, setCurrentTurnId] = useState('');
  // "Welcome back." after a rejoin: shown in the caption before the pending
  // question, never spoken — the spoken text must stay the stored turn, which
  // is what server speech synthesises from.
  const [captionPrefix, setCaptionPrefix] = useState('');
  const [interim, setInterim] = useState('');
  const [typed, setTyped] = useState('');
  const [textMode, setTextMode] = useState(false);
  // Read by the listening path at the moment it runs. submitAnswer and friends
  // are memoised on the token alone, so the state value they closed over was
  // the first render's — "not typing" — and after every typed answer the room
  // opened the microphone and the recognizer, even for a candidate who had
  // declined voice capture. Refs cannot go stale that way.
  const textModeRef = useRef(false);
  const canCaptureRef = useRef(false);
  const setTextModeTracked = useCallback((on: boolean) => {
    textModeRef.current = on;
    setTextMode(on);
  }, []);
  // The last answer is on record without a reply: offer Continue.
  const [awaitingReply, setAwaitingReply] = useState(false);
  // Set when the interview turned out to be complete already (another tab, or
  // the reply this room missed was the sign-off). The done screen then says so
  // plainly instead of describing a session this room did not see.
  const [completedNote, setCompletedNote] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [micLevel, setMicLevel] = useState(0);
  // Tracked so the capture indicator reflects whether the mic is ACTUALLY open,
  // rather than whether we asked for it. A candidate who denied permission is
  // not being captured and must not be shown a badge saying they are.
  const [micOpen, setMicOpen] = useState(false);
  const [err, setErr] = useState('');
  // The end-of-interview question. `null` means no answer is on file yet; once
  // there is one the question is not put again, in either direction.
  const [feedbackChoice, setFeedbackChoice] = useState<string | null>(null);
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');

  // Whether this interview may listen at all. A candidate who declined voice
  // capture is interviewed by typing: the microphone is never requested, and the
  // speak-and-listen controls are not offered.
  const canCapture = shouldCaptureAudio(info?.recordingConsented);

  /**
   * Record the candidate's answer. The server is the one that decides what
   * sticks — a replay returns the answer already on file — so this takes its
   * result rather than assuming the click won.
   */
  const answerFeedback = useCallback(async (wantsFeedback: boolean) => {
    setFeedbackSaving(true);
    setFeedbackError('');
    try {
      const res = await api.post<{ optIn: { choice: string } }>(
        `/portal/${token}/feedback-opt-in`, { wantsFeedback },
      );
      setFeedbackChoice(res.optIn.choice);
    } catch {
      // Never a blocking error: their interview is already safely submitted, and
      // this question is an extra. Offer them a way through that does not depend
      // on us.
      setFeedbackError('We could not record that just now — please reply to your invitation email instead.');
    } finally {
      setFeedbackSaving(false);
    }
  }, [token]);

  const recognizerRef = useRef<Recognizer | null>(null);
  const meterRef = useRef<MicMeter | null>(null);
  const recordingRef = useRef<Recording | null>(null);
  const recognizerFailedRef = useRef(false);
  const startTimeRef = useRef(0);
  // When the candidate was first able to answer the current question.
  const turnStartRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // One answer per turn. The recognizer's end event and the "Done answering"
  // watchdog can both fire for the same answer, and without this the candidate
  // submits twice — the second one empty, which reads as a non-answer.
  const turnClosedRef = useRef(false);
  const doneWatchdogRef = useRef<number | null>(null);
  // Escalates the check-in wording within a turn, and resets with the turn so
  // the next question starts from the gentlest phrasing again.
  const silenceCountRef = useRef(0);
  // The question on screen, sent with each answer so the server can refuse one
  // aimed at a question the interview has already moved past.
  const currentTurnIdRef = useRef('');
  // Stops the wait-for-reply loop once the room is gone.
  const unmountedRef = useRef(false);
  // Read by callbacks created before the portal info arrived, so the fallback
  // browser voice is always this interviewer's, never the default.
  const voiceHintRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    api.get<PortalInfo>(`/portal/${token}`)
      .then((d) => {
        setInfo(d);
        voiceHintRef.current = d.persona?.voiceHint;
        // A candidate who already answered — on another device, or before a
        // reload — is shown their answer rather than the question again.
        setFeedbackChoice(d.feedbackOptIn?.choice ?? null);
        canCaptureRef.current = shouldCaptureAudio(d.recordingConsented);
        // No consent to capture voice means no microphone at all — the
        // interview is answered by typing. The AI still speaks: that is output,
        // not capture.
        if (!sttSupported() || !shouldCaptureAudio(d.recordingConsented)) setTextModeTracked(true);
      })
      .catch((e: Error) => setErr(e.message));
  }, [token]);

  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [msgs, interim, showTranscript]);

  // Frame loop for the mic meter. It no-ops until a meter exists, so a
  // candidate who denied mic access does not drive an animation that can never
  // move.
  useEffect(() => {
    let raf = 0;
    const loop = () => { if (meterRef.current) setMicLevel(meterRef.current.level()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => () => {
    unmountedRef.current = true;
    meterRef.current?.stop();
    stopAllSpeech();
    recognizerRef.current?.abort();
    // Otherwise a pending watchdog fires after unmount and sets state on a
    // component that is gone.
    if (doneWatchdogRef.current !== null) window.clearTimeout(doneWatchdogRef.current);
  }, []);

  const addMsg = (m: Msg) => setMsgs((prev) => [...prev, m]);

  const sendIntegrityEvent = useCallback((type: 'TAB_BLUR' | 'FOCUS_LOST' | 'PASTE_DETECTED', detail?: Record<string, unknown>) => {
    // Fire-and-forget by design: browser-integrity telemetry must never make the
    // interview feel broken to the candidate. The server gates this on consent
    // and tenant policy before storing anything.
    void fetch(`/api/portal/${token}/integrity-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, detail }),
      credentials: 'include',
    }).catch(() => undefined);
  }, [token]);

  useEffect(() => {
    if (!info?.proctoringEnabled || phase === 'ready' || phase === 'done') return undefined;
    const onVisibility = () => { if (document.hidden) sendIntegrityEvent('TAB_BLUR'); };
    const onBlur = () => sendIntegrityEvent('FOCUS_LOST');
    // Pasting into the typed-answer accommodation textarea is a legitimate,
    // expected way to answer (see the "voice or typed" affordance above) — not
    // an integrity signal. Flagging it would penalize exactly the candidates
    // this fallback exists to support, so it is excluded here rather than left
    // for a human reviewer to have to discount later.
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.getAttribute('data-answer-input') === 'true') return;
      sendIntegrityEvent('PASTE_DETECTED');
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('paste', onPaste);
    };
  }, [info?.proctoringEnabled, phase, sendIntegrityEvent]);

  const submitAnswer = useCallback(async (text: string) => {
    if (!text.trim()) return;
    recognizerRef.current?.abort();
    recognizerRef.current = null;
    setInterim('');
    setPhase('thinking');
    const now = Date.now();
    // The real moment this answer began, not "twenty-five seconds ago". These
    // become the timestamps quoted as evidence beside the transcript, and a
    // made-up one points a reviewer at the wrong part of the interview. Null
    // when it is genuinely not known; the server omits the stamp rather than
    // inventing one.
    const startMs = turnStartRef.current && startTimeRef.current
      ? Math.max(0, turnStartRef.current - startTimeRef.current)
      : null;
    const endMs = startTimeRef.current ? now - startTimeRef.current : null;
    try {
      const res = await api.post<{ turn: AgentTurn }>(`/portal/${token}/turn`, {
        text, startMs, endMs, inReplyTo: currentTurnIdRef.current || undefined,
      });
      // Only show the answer once the server has it. Showing it first made a
      // failed submit invisible: the candidate saw their answer sitting in the
      // transcript looking delivered while the server never received it, and
      // the text was already cleared so they could not resend it. A silent loss
      // that looks like success is the worst outcome in an interview.
      addMsg({ speaker: 'candidate', text });
      setTyped('');
      // A retry that worked must not leave "your answer was not sent" on screen.
      setErr('');
      setAwaitingReply(false);
      addMsg({ speaker: 'agent', text: res.turn.text });
      sayAndListen(res.turn);
    } catch (e: unknown) {
      const refusal = refusalOf(e);
      if (refusal === 'finished') { showFinished(); return; }
      if (refusal === 'stale') { void catchUpAfterStale(text); return; }
      // Keep the text so they can retry rather than reconstruct what they said.
      turnClosedRef.current = false;
      setTyped(text);
      setTextModeTracked(true);
      setErr(`${errorMessage(e)} — your answer was not sent. It's in the box below; press Send to try again.`);
      setPhase('listening');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /**
   * The interviewer checks in after a long silence, then goes back to listening.
   *
   * Recognition is stopped while the check-in plays, or the microphone would
   * transcribe the interviewer's own words into the candidate's answer.
   */
  const checkInOnSilence = useCallback(async () => {
    if (turnClosedRef.current) return;
    const n = Math.min(silenceCountRef.current, 2);
    silenceCountRef.current += 1;

    recognizerRef.current?.abort();
    recognizerRef.current = null;
    setPhase('speaking');

    const said = await speakNudge(token, n, voiceHintRef.current);
    if (said) addMsg({ speaker: 'agent', text: said });

    // They may have finished or navigated while it was speaking.
    if (turnClosedRef.current) return;
    setPhase('listening');
    void beginListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const beginListening = useCallback(async () => {
    // When this turn's answer actually started, for the evidence timestamps.
    turnStartRef.current = Date.now();
    if (!listensByVoice({ textMode: textModeRef.current, canCapture: canCaptureRef.current })) {
      // Without consent to capture, the keyboard is the only way to answer.
      if (!canCaptureRef.current && !textModeRef.current) setTextModeTracked(true);
      turnClosedRef.current = false;
      setPhase('listening');
      return;
    }
    setInterim('');
    setPhase('listening');
    // A new turn is open for answering again.
    turnClosedRef.current = false;
    silenceCountRef.current = 0;

    // Always record. The recording is what gets transcribed if the browser's
    // own recognition fails — without it a `network` error loses the answer
    // outright and the candidate has to repeat themselves.
    // Checked again at the call itself: nothing may open the microphone for a
    // candidate who declined voice capture, whatever path led here.
    recordingRef.current = canCaptureRef.current ? await startRecording() : null;

    const rec = createRecognizer({
      onInterim: setInterim,
      onFinal: (t) => closeTurn(t),
      onError: (e) => {
        if (e === 'no-speech') return;
        // Do not surface this as an error yet: if we captured audio, the server
        // can still transcribe it and the candidate never needs to know.
        recognizerFailedRef.current = true;
        if (!recordingRef.current) setErr(`Speech error: ${e}. You can type your answer instead.`);
      },
      // Long silence. The interviewer speaks rather than a banner appearing: a
      // candidate who has gone quiet is usually thinking or stuck, and a person
      // conducting this interview would say something. A silent screen with a
      // warning on it is the moment an interview stops feeling like one.
      //
      // The turn is NOT closed and nothing is submitted — this is a check-in,
      // not a prompt to wrap up.
      onSilence: () => { void checkInOnSilence(); },
      // Capture is broken and will not recover. Offer the keyboard immediately
      // rather than letting them keep talking to a microphone that is not on.
      onDead: () => {
        recognizerFailedRef.current = true;
        setTextModeTracked(true);
        setErr('Your microphone stopped working. Please type your answer below — nothing you have said so far is lost.');
      },
    });
    if (!rec) {
      // No browser recognition at all. Recording alone still works if the
      // server can transcribe; otherwise fall back to typing.
      if (!recordingRef.current) { setTextModeTracked(true); setPhase('listening'); }
      return;
    }
    recognizerRef.current = rec;
    rec.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Turn "the candidate stopped talking" into text, from whichever source
   * actually produced any. Browser recognition is preferred when it worked
   * (no upload, no cost); otherwise the recording goes to the server.
   */
  const finishAnswer = useCallback(async (recognised: string) => {
    const rec = recordingRef.current;
    recordingRef.current = null;
    const audio = rec ? await rec.stop() : null;

    if (recognised.trim()) { void submitAnswer(recognised); return; }

    if (audio) {
      setPhase('thinking');
      setInterim('Transcribing your answer…');
      try {
        const text = await transcribeOnServer(token, audio);
        if (text) { setInterim(''); recognizerFailedRef.current = false; void submitAnswer(text); return; }
      } catch {
        // A failed transcription used to leave the room on "Transcribing your
        // answer…" for good, with the rejection unhandled: the candidate sat
        // in front of a screen that had stopped listening and never said so.
        setInterim('');
        turnClosedRef.current = false;
        setTextModeTracked(true);
        setPhase('listening');
        setErr('We could not transcribe that just now. Nothing you have said is lost — please type this answer below.');
        return;
      }
      setInterim('');
      turnClosedRef.current = false;
      setTextModeTracked(true);
      setPhase('listening');
      setErr('We could not transcribe that just now. Nothing you have said is lost — please type this answer below.');
      return;
    }

    // Nothing usable from either path. The turn did NOT close — reopen it, or
    // the candidate is told to try again by a screen that will ignore them.
    turnClosedRef.current = false;
    setPhase('listening');
    setErr(recognizerFailedRef.current
      ? 'We could not hear that. Please try again, or type your answer instead.'
      : 'No speech detected. Please try again, or type your answer instead.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /**
   * Close the turn exactly once, whichever path got here first — the
   * recognizer's end event or the "Done answering" watchdog.
   */
  const closeTurn = useCallback((text: string) => {
    if (turnClosedRef.current) return;
    turnClosedRef.current = true;
    if (doneWatchdogRef.current !== null) {
      window.clearTimeout(doneWatchdogRef.current);
      doneWatchdogRef.current = null;
    }
    void finishAnswer(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishAnswer]);

  /**
   * "Done answering" — the candidate says the turn is over.
   *
   * This used to call `stop()` and trust the recognizer's end event to deliver
   * the text. When the browser had not finalised anything yet there was no text
   * to deliver, nothing fired, and the button did nothing at all — candidates
   * pressed it repeatedly with no feedback. Now the text is read straight off
   * the recognizer, with a watchdog for the case where the end event never
   * arrives at all.
   */
  /**
   * Switching to the keyboard mid-answer.
   *
   * The recognizer used to be left running: it finalised whatever fragment it
   * had a moment later and submitted it as the answer, over the top of someone
   * who had just decided to type instead.
   */
  const switchToTyping = () => {
    recognizerRef.current?.abort();
    recognizerRef.current = null;
    if (doneWatchdogRef.current !== null) {
      window.clearTimeout(doneWatchdogRef.current);
      doneWatchdogRef.current = null;
    }
    setInterim('');
    setTextModeTracked(true);
    setPhase('listening');
  };

  const doneAnswering = () => {
    // Repeated presses must not each install a watchdog: only the newest id is
    // stored, so an earlier timer would survive uncancelled and fire into a
    // later turn.
    if (turnClosedRef.current || doneWatchdogRef.current !== null) return;
    const rec = recognizerRef.current;
    if (!rec) { closeTurn(''); return; }
    setPhase('thinking');
    // Read the text when the watchdog FIRES, not now. Chrome often finalises a
    // trailing phrase in the moment between the click and the end event, and
    // capturing the snapshot here threw that phrase away — the candidate lost
    // the last thing they said.
    doneWatchdogRef.current = window.setTimeout(() => closeTurn(rec.text()), 1500);
    rec.stop();
  };

  /** Put a question on screen as the one the next answer replies to. */
  function showQuestion(turn: AgentTurn, prefix: string) {
    setCurrentAgent(turn.text);
    setCurrentTurnId(turn.turnId);
    currentTurnIdRef.current = turn.turnId;
    setCaptionPrefix(prefix);
  }

  function sayAndListen(turn: AgentTurn, prefix = '') {
    setCurrentAgent(turn.text);
    setCurrentTurnId(turn.turnId);
    currentTurnIdRef.current = turn.turnId;
    setCaptionPrefix(prefix);
    setPhase('speaking');
    void speakTurn({
      token, turnId: turn.turnId, text: turn.text, voiceHint: voiceHintRef.current,
      onDone: () => {
        if (turn.done) {
          // Close the microphone at the end rather than at unmount. The capture
          // indicator disappears here, and it must disappear because capture has
          // actually stopped — not merely because the screen changed.
          meterRef.current?.stop();
          meterRef.current = null;
          setMicOpen(false);
          setPhase('done');
          // Show what was captured. A candidate who has just spoken for half an
          // hour has no idea whether any of it registered, and asking them to
          // trust that it did is not reasonable when the whole transcript is
          // already here. It stays open until they close it — a timed reveal
          // would make them race to read their own words.
          setShowTranscript(true);
          return;
        }
        // beginListening handles typed mode too, and it records when this
        // answer began; skipping it left typed answers without a start time.
        void beginListening();
      },
    });
  }

  /** How a refused request should be handled, from what the server said. */
  function refusalOf(e: unknown) {
    return roomRefusal(e instanceof ApiError ? e.status : undefined, e instanceof ApiError ? e.code : undefined, errorMessage(e));
  }

  /**
   * The interview is already complete. Retrying would only meet the same
   * refusal, so the room closes the microphone and says so.
   */
  function showFinished() {
    recognizerRef.current?.abort();
    recognizerRef.current = null;
    meterRef.current?.stop();
    meterRef.current = null;
    setMicOpen(false);
    setErr('');
    // The same words the portal shows for a finished interview.
    setCompletedNote(FINISHED_ENTRY.message);
    setPhase('done');
  }

  /**
   * Open the room on what start returned: the opening on a fresh start, or on
   * a rejoin the conversation so far and only the pending question.
   */
  function applyOpening(res: StartResponse, allowWait = true) {
    const opening = roomOpening(res, { allowWait });
    // Set back so answers given now are stamped after everything on record.
    startTimeRef.current = Date.now() - opening.clockOffsetMs;
    setMsgs(opening.messages);
    setAwaitingReply(opening.mode !== 'speak');
    if (opening.mode === 'wait') {
      showQuestion(opening.turn, opening.captionPrefix);
      // The caption says only that the room is picking up: the question beside
      // it has been answered, and the reply is the next thing to show.
      setCurrentAgent('');
      setPhase('thinking');
      void waitForReply();
      return;
    }
    if (opening.mode === 'listen') {
      showQuestion(opening.turn, opening.captionPrefix);
      void beginListening();
      return;
    }
    sayAndListen(opening.turn, opening.captionPrefix);
  }

  /**
   * The candidate's answer went in moments before the rejoin, so its reply is
   * most likely still being produced. Re-read until it lands rather than invite
   * them to answer a question they already answered; after the budget, offer
   * Continue instead.
   */
  async function waitForReply() {
    const began = Date.now();
    let latest: StartResponse | null = null;
    while (keepWaitingForReply(Date.now() - began)) {
      await new Promise((resolve) => window.setTimeout(resolve, REPLY_POLL_INTERVAL_MS));
      if (unmountedRef.current) return;
      try {
        latest = await api.post<StartResponse>(`/portal/${token}/start`, {});
      } catch (e: unknown) {
        if (refusalOf(e) === 'finished') { showFinished(); return; }
        continue;
      }
      if (!latest.awaitingReply) { applyOpening(latest); return; }
    }
    if (latest) {
      applyOpening(latest, false);
      return;
    }
    setAwaitingReply(true);
    void beginListening();
  }

  /**
   * The answer was aimed at a question the interview had already moved past —
   * another tab, or a reply that landed during a reload. Nothing was recorded;
   * put the current question up and keep what they wrote so nothing is lost.
   */
  async function catchUpAfterStale(keptText: string) {
    setTyped(keptText);
    setTextModeTracked(true);
    try {
      const res = await api.post<StartResponse>(`/portal/${token}/start`, {});
      applyOpening(res);
      setErr('The interview had already moved on to a newer question, so that answer was not sent. It is still in the box below — edit it or send it as it is.');
    } catch (e: unknown) {
      if (refusalOf(e) === 'finished') { showFinished(); return; }
      turnClosedRef.current = false;
      setErr(`${errorMessage(e)} — your answer was not sent. It is in the box below; press Send to try again.`);
      setPhase('listening');
    }
  }

  /** Nothing to add to the saved answer: ask for the reply to it. */
  const continueInterview = async () => {
    recognizerRef.current?.abort();
    recognizerRef.current = null;
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording) void recording.stop();
    setInterim('');
    setErr('');
    setPhase('thinking');
    try {
      const res = await api.post<{ turn: AgentTurn }>(`/portal/${token}/continue`, {});
      setAwaitingReply(false);
      // The server hands back the pending question if a reply already existed;
      // only a question not yet on screen joins the transcript.
      if (res.turn.turnId !== currentTurnIdRef.current) addMsg({ speaker: 'agent', text: res.turn.text });
      sayAndListen(res.turn);
    } catch (e: unknown) {
      if (refusalOf(e) === 'finished') { showFinished(); return; }
      setErr(`${errorMessage(e)} Please try again.`);
      void beginListening();
    }
  };

  const begin = async () => {
    setErr('');
    startTimeRef.current = Date.now();
    setPhase('thinking');
    // Requested here rather than on load: a permission prompt that appears
    // before the candidate has chosen to start reads as the page grabbing the
    // mic, and gets denied. Not requested at all without consent to capture.
    if (canCapture) {
      meterRef.current = await createMicMeter();
      setMicOpen(meterRef.current !== null);
    }
    try {
      const res = await api.post<StartResponse>(`/portal/${token}/start`, {});
      applyOpening(res);
    } catch (e: unknown) {
      if (refusalOf(e) === 'finished') { showFinished(); return; }
      setErr(errorMessage(e));
      setPhase('ready');
    }
  };

  const repeat = () => {
    stopAllSpeech();
    recognizerRef.current?.abort();
    void speakTurn({ token, turnId: currentTurnId, text: currentAgent, voiceHint: voiceHintRef.current, onDone: () => { if (!textModeRef.current) beginListening(); } });
  };

  if (err && !info) return <div className="center-screen"><div className="card auth-card"><div className="banner error">{err}</div></div></div>;
  if (!info) {
    return (
      <div className="center-screen muted" role="status">
        <span className="check-label"><Icon name="refresh" size={18} />Connecting to the interview room…</span>
      </div>
    );
  }

  // The name on screen is the interviewer this candidate was actually
  // introduced to, always labelled as an AI.
  const header = interviewRoomHeader(info.persona);
  const interviewer = interviewerName(info.persona?.name);
  const live = phase !== 'ready' && phase !== 'done';
  const speaking = phase === 'speaking';
  const listening = phase === 'listening' && !textMode;

  return (
    <div className="room">
      <h1 className="visually-hidden">Your interview</h1>
      <header className="room-bar">
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          {/* The room is dark in both themes, so it always takes the dark cut. */}
          <BrandLogo variant="lockup" size={22} surfaceTone="dark" className="candidate-logo" />
          <span className="room-role">{info.roleTitle}</span>
        </div>
        <div className="room-interviewer" data-testid="room-interviewer">
          <span className="room-interviewer-avatar" aria-hidden="true">{header.initial}</span>
          <span className="room-interviewer-text">
            <span className="room-interviewer-name">{header.name}</span>
            <span className="room-interviewer-role">{header.role}</span>
          </span>
        </div>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          {live && micOpen && (
            <CaptureIndicator mode={textMode ? 'mic' : 'transcribing'} stt={info.speech.stt} />
          )}
          <span className="room-timer"><Elapsed since={startTimeRef.current} /></span>
        </div>
      </header>

      <main className="stage">
        <div className={`tile ${speaking ? 'is-active' : ''}`}>
          <SpeakingRings active={speaking} level={0.35} />
          <div className="tile-avatar agent-avatar">{header.initial}</div>
          <div className="tile-name">{header.name} <span className="tile-tag">{header.role}</span></div>
          <div className="tile-status">
            {speaking ? 'Speaking' : phase === 'thinking' ? 'Thinking…' : phase === 'done' ? 'Signed off' : 'Ready'}
          </div>
        </div>

        <div className={`tile ${listening ? 'is-active' : ''}`}>
          <SpeakingRings active={listening} level={micLevel} />
          <div className="tile-avatar you-avatar">{initials(info.candidateName)}</div>
          <div className="tile-name">{info.candidateName} <span className="tile-tag">you</span></div>
          <div className="tile-status">
            {textMode ? 'Typing' : listening ? 'Your turn — speak now' : 'Mic ready'}
          </div>
          {!textMode && (
            <div className="mic-bars" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} style={{ height: `${6 + Math.max(0, micLevel * 34 - i * 3)}px` }} />
              ))}
            </div>
          )}
        </div>
      </main>

      {captionsOn && (currentAgent || captionPrefix || interim) && phase !== 'ready' && (
        <div className="captions">
          {listening && interim
            ? <p><span className="cap-who">You</span>{interim}</p>
            : <p><span className="cap-who">{interviewer}</span>{captionPrefix && `${captionPrefix} `}{currentAgent}</p>}
        </div>
      )}

      {err && <div className="room-error">{err}</div>}

      <footer className="controls">
        {phase === 'ready' && (
          <div className="join-panel">
            <p className="muted">
              {info.durationMinutes} minutes · voice or typed · you can ask {interviewer} to repeat anything.
            </p>
            {/* Repeated here, not just on the consent screen. The consent screen may
                have been read minutes ago on another device, and this is the last
                moment before the microphone actually opens. */}
            <div className="muted" style={{ textAlign: 'left', maxWidth: 520, margin: '0 auto' }}>
              <VoiceHandling stt={info.speech.stt} />
            </div>
            <button type="button" className="btn btn-join" onClick={begin}><Icon name="play" size={18} />Join interview</button>
          </div>
        )}

        {phase === 'listening' && awaitingReply && (
          <button type="button" className="btn secondary" onClick={() => void continueInterview()}>
            <Icon name="arrow-right" size={16} />Continue
          </button>
        )}

        {listening && (
          <>
            <button type="button" className="ctl" onClick={repeat}><Icon name="refresh" /><span>Repeat</span></button>
            <button type="button" className="ctl" onClick={() => setCaptionsOn((c) => !c)} aria-pressed={captionsOn}>
              <Icon name="captions" label="Captions" /><span>{captionsOn ? 'On' : 'Off'}</span>
            </button>
            <button type="button" className="btn btn-done" onClick={doneAnswering}><Icon name="check" size={18} />Done answering</button>
            <button type="button" className="ctl" onClick={switchToTyping}><Icon name="keyboard" /><span>Type</span></button>
            <button type="button" className="ctl" onClick={() => setShowTranscript((s) => !s)} aria-expanded={showTranscript}>
              <Icon name="list" /><span>Transcript</span>
            </button>
          </>
        )}

        {phase === 'listening' && textMode && (
          <div className="type-row">
            <textarea
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type your answer, then Send… (Ctrl+Enter)"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitAnswer(typed); }}
              data-answer-input="true"
            />
            <div className="type-actions">
              <button type="button" className="btn btn-done" onClick={() => void submitAnswer(typed)} disabled={!typed.trim()}><Icon name="send" size={16} />Send</button>
              {sttSupported() && canCapture && <button type="button" className="ctl" onClick={() => setTextModeTracked(false)}><Icon name="mic" /><span>Voice</span></button>}
            </div>
          </div>
        )}

        {(speaking || phase === 'thinking') && (
          <div className="controls-hint">
            <span>{speaking ? 'Listen to the question…' : 'One moment…'}</span>
            {speaking && <button type="button" className="ctl" onClick={repeat}><Icon name="refresh" /><span>Repeat</span></button>}
          </div>
        )}

        {/* Reached from a refusal rather than the sign-off: this room saw none
            of the interview, so it says only that it is complete. */}
        {phase === 'done' && completedNote && (
          <div className="done-panel">
            <h3>Your interview is complete</h3>
            <p className="muted">{completedNote}</p>
          </div>
        )}

        {phase === 'done' && !completedNote && (
          <div className="done-panel">
            <h3>That's everything — thank you.</h3>
            <p className="muted">
              Your microphone is now off. Your interview has been submitted for human review: a person on
              the hiring team reads the <b>transcript</b> — the text of what you said, which is all that
              was kept — and makes the decision. No recording of your voice exists.
            </p>
            <p className="muted">
              <b>Everything that was captured is in the transcript</b>, exactly as the reviewer will see
              it. Take as long as you like to read it before closing this window. If something you said is
              missing or came out wrong, reply to your invitation email and tell us — we would rather know.
            </p>
            {/* Closed by mistake, the transcript had no way back in this phase. */}
            {!showTranscript && (
              <button type="button" className="btn secondary" onClick={() => setShowTranscript(true)} aria-expanded={false}>
                <Icon name="list" size={16} />Show transcript
              </button>
            )}

            {/* Asked here, and only here: the invitation link is consumed the
                moment the interview finalises, so this is the last moment the
                candidate can be asked anything at all. */}
            {info?.feedbackOptIn?.offered && (
              <div style={{ marginTop: 16 }}>
                {feedbackChoice === null ? (
                  <>
                    <p><b>{FEEDBACK_QUESTION}</b></p>
                    <p className="muted">{FEEDBACK_EXPLANATION}</p>
                    <div className="row">
                      <button type="button" className="btn" disabled={feedbackSaving} onClick={() => void answerFeedback(true)}>
                        {FEEDBACK_YES_LABEL}
                      </button>
                      <button type="button" className="btn secondary" disabled={feedbackSaving} onClick={() => void answerFeedback(false)}>
                        {FEEDBACK_NO_LABEL}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="muted">{answerConfirmation(feedbackChoice)}</p>
                )}
                {feedbackError && <p className="muted">{feedbackError}</p>}
              </div>
            )}
          </div>
        )}
      </footer>

      {/* inert while closed: off-screen is not gone, and its close button and
          text were still reachable by Tab and read by a screen reader. */}
      <aside
        className={`transcript-panel ${showTranscript ? 'open' : ''}`}
        aria-label="Transcript"
        {...(showTranscript ? {} : { inert: '' })}
      >
        <div className="row spread" style={{ marginBottom: 10 }}>
          <strong>Transcript</strong>
          <button type="button" className="ctl" onClick={() => setShowTranscript(false)}><Icon name="close" label="Close transcript" /></button>
        </div>
        <div className="transcript-scroll" ref={scrollRef}>
          {msgs.length === 0 && <p className="muted small">The conversation will appear here as you go.</p>}
          {msgs.map((m, i) => (
            <div key={i} className={`turn ${m.speaker}`}>
              <div className="who">{m.speaker === 'agent' ? interviewer : 'You'}</div>
              <div className="bubble">{m.text}</div>
            </div>
          ))}
        </div>
      </aside>

      {!ttsSupported() && phase === 'ready' && (
        <p className="room-note">Your browser can't play synthesised speech — questions will appear as text.</p>
      )}
    </div>
  );
}
