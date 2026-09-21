import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  speakTurn, stopAllSpeech, createMicMeter, sttSupported, ttsSupported, type MicMeter,
} from '../speech';
import type { SttCapability } from './Portal';
import { interviewerName } from '../components/candidateJourney';
import { interviewRoomHeader, roomAiFact } from '../components/interviewerModel';
import { shouldCaptureAudio } from '../components/portalConsentModel';
import { FINISHED_ENTRY } from '../components/portalEntryModel';
import type { StartResponse } from '../components/roomResumeModel';
import { AiVoiceLevel } from '../components/room/aiVoiceLevel';
import { Composer } from '../components/room/Composer';
import { ConversationPanel, type RevealingMessage } from '../components/room/Conversation';
import { ParticipantsRail } from '../components/room/ParticipantsRail';
import { DonePanel, JoinPanel, LeaveDialog, RoomLoading, RoomPrivacy } from '../components/room/RoomPanels';
import { RoomTopBar } from '../components/room/RoomTopBar';
import { LEAVE_MARKER, joinAnswer, speakAvailability } from '../components/room/roomComposerModel';
import { useAnswerMode, useRefState } from '../components/room/useAnswerMode';
import {
  aiStatus, candidateStatus, fromTranscript, initials, type RoomMessage, type RoomPhase,
} from '../components/room/roomConversationModel';
import { questionNumber } from '../components/room/roomProgressModel';
import { useVoiceAnswer } from '../components/room/useVoiceAnswer';
import { refusalOf, useRejoin } from '../components/room/useRejoin';
import { useAnswerControls } from '../components/room/useAnswerControls';
import { useLeave, type PortalTurn } from '../components/room/useLeave';
import { useFeedbackOptIn, useIntegrityEvents, useVisualViewport } from '../components/room/useRoomServices';

// The interview room is the only screen a candidate ever sees, and it is the
// screen they judge the company by. It borrows the grammar of a video call —
// participants on one side, the conversation in writing on the other, and one
// place to answer — so nobody has to learn a new UI while also being assessed.
// This file is the orchestrator: turn-taking, capture and the server calls.
// What things look like lives in components/room.

/** A turn as the portal sends it to the room: only what the room uses. */
type AgentTurn = PortalTurn;
interface PortalInfo {
  candidateName: string; roleTitle: string; durationMinutes: number;
  /** The session's language code ('en', 'en-GB', …); absent on an older server. */
  language?: string;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function InterviewRoom() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<PortalInfo | null>(null);
  const [phase, setPhase, phaseRef] = useRefState<RoomPhase>('ready');
  const [msgs, setMsgs] = useState<readonly RoomMessage[]>([]);
  const [currentAgent, setCurrentAgent] = useState('');
  // "Welcome back." after a rejoin: shown before the pending question, never
  // spoken — the spoken text must stay the stored turn, which is what server
  // speech synthesises from.
  const [questionPrefix, setQuestionPrefix] = useState('');
  // The last answer is on record without a reply: offer Continue.
  const [awaitingReply, setAwaitingReply] = useState(false);
  // Set when the interview turned out to be complete already (another tab, or
  // the reply this room missed was the sign-off). The done screen then says so
  // plainly instead of describing a session this room did not see.
  const [completedNote, setCompletedNote] = useState('');
  const [interim, setInterim] = useState('');
  const [typed, setTyped] = useState('');
  const [paused, setPaused, pausedRef] = useRefState(false);
  const [revealing, setRevealing] = useState<{ id: string; text: string } | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  // The question on screen is the sign-off: the interview is finalised, and
  // there is nothing left to leave.
  const [currentDone, setCurrentDone] = useState(false);
  // The interview ended because the candidate chose to stop.
  const [withdrawn, setWithdrawn] = useState(false);
  // Tracked so the capture indicator reflects whether the mic is ACTUALLY open,
  // rather than whether we asked for it. A candidate who denied permission is
  // not being captured and must not be shown a badge saying they are.
  const [micOpen, setMicOpen] = useState(false);
  const [err, setErr] = useState('');

  // Whether this interview may listen at all. A candidate who declined voice
  // capture is interviewed by typing: the microphone is never requested, and the
  // speak-and-listen controls are not offered.
  const canCapture = shouldCaptureAudio(info?.recordingConsented);
  const speakUnavailable = speakAvailability({ consented: canCapture, sttSupported: sttSupported() });
  const speakUnavailableRef = useRef(speakUnavailable);
  speakUnavailableRef.current = speakUnavailable;
  // Read by the listening path at the moment it runs, never from a closure:
  // a stale "may capture" is how a typed room once opened the microphone.
  const canCaptureRef = useRef(false);
  const answerMode = useAnswerMode(speakUnavailableRef);
  const { mode, textMode, setTextMode, textModeRef, codeMode, setCodeMode, applyQuestionMode } = answerMode;

  const meterRef = useRef<MicMeter | null>(null);
  const startTimeRef = useRef(0);
  // Bumped whenever speech is replaced or abandoned, so a stale "finished
  // speaking" (from a cancelled utterance) cannot open the mic for a turn.
  const speechSeqRef = useRef(0);
  const currentTurnRef = useRef<AgentTurn | null>(null);
  const msgSeqRef = useRef(0);
  // The newest line the room opened on, revealed as it is spoken on a fresh start.
  const lastOpenedIdRef = useRef('');
  const aiVoice = useMemo(() => new AiVoiceLevel(), []);
  // Read by callbacks created before the portal info arrived, so the fallback
  // browser voice is always this interviewer's, never the default.
  const voiceHintRef = useRef<string | undefined>(undefined);
  // Likewise, the language the recognizer listens in.
  const languageRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    api.get<PortalInfo>(`/portal/${token}`)
      .then((d) => {
        setInfo(d);
        voiceHintRef.current = d.persona?.voiceHint;
        languageRef.current = d.language;
        canCaptureRef.current = shouldCaptureAudio(d.recordingConsented);
        // No consent to capture voice means no microphone at all — the
        // interview is answered by typing. The AI still speaks: that is output,
        // not capture.
        if (!sttSupported() || !shouldCaptureAudio(d.recordingConsented)) setTextMode(true);
      })
      .catch((e: Error) => setErr(e.message));
  }, [token, setTextMode]);

  useEffect(() => aiVoice.listen(), [aiVoice]);

  useEffect(() => () => {
    meterRef.current?.stop();
    stopAllSpeech();
  }, []);

  // The sign-off arrived while the Leave dialog was open: close it.
  useEffect(() => { if (currentDone) setLeaveOpen(false); }, [currentDone]);

  /** Words that must not be lost go into the typed draft, after whatever is already there. */
  const mergeIntoDraft = (text: string) => {
    setTyped((prev) => (prev.trim() && prev.trim() !== text.trim() ? joinAnswer(prev, text) : text));
  };

  const addMsg = (m: Omit<RoomMessage, 'id' | 'atMs'>, atMs?: number | null): string => {
    msgSeqRef.current += 1;
    const id = `m${msgSeqRef.current}`;
    const at = atMs !== undefined ? atMs : startTimeRef.current ? Date.now() - startTimeRef.current : null;
    setMsgs((prev) => [...prev, { ...m, id, atMs: at }]);
    return id;
  };

  useIntegrityEvents(token, info?.proctoringEnabled === true, phase);
  useVisualViewport();
  const feedback = useFeedbackOptIn(token, info?.feedbackOptIn?.offered === true, info?.feedbackOptIn?.choice ?? null);

  const submitAnswer = async (text: string, opts: { code?: boolean } = {}) => {
    if (!text.trim()) return;
    voice.detachRecognizer();
    setInterim('');
    setPaused(false);
    setPhase('thinking');
    const now = Date.now();
    // The real moment this answer began, not "twenty-five seconds ago". These
    // become the timestamps quoted as evidence beside the transcript, and a
    // made-up one points a reviewer at the wrong part of the interview. Null
    // when it is genuinely not known; the server omits the stamp rather than
    // inventing one.
    const turnStart = voice.turnStartRef.current;
    const startMs = turnStart && startTimeRef.current
      ? Math.max(0, turnStart - startTimeRef.current)
      : null;
    const endMs = startTimeRef.current ? now - startTimeRef.current : null;
    try {
      const res = await api.post<{ turn: AgentTurn }>(`/portal/${token}/turn`, {
        text, startMs, endMs,
        // The question on screen, so the server can refuse an answer aimed at
        // one the interview has moved past.
        inReplyTo: currentTurnRef.current?.turnId || undefined,
      });
      // Only show the answer once the server has it. Showing it first made a
      // failed submit invisible: the candidate saw their answer sitting in the
      // transcript looking delivered while the server never received it, and
      // the text was already cleared so they could not resend it. A silent loss
      // that looks like success is the worst outcome in an interview.
      addMsg({ speaker: 'candidate', text, code: opts.code === true }, startMs ?? endMs);
      setTyped('');
      // A retry that worked must not leave "your answer was not sent" on screen.
      setErr('');
      setAwaitingReply(false);
      receiveTurn(res.turn);
    } catch (e: unknown) {
      const refusal = refusalOf(e);
      if (refusal === 'finished') { showFinished(); return; }
      if (refusal === 'stale') { void rejoin.catchUpAfterStale(text); return; }
      // Keep the text so they can retry rather than reconstruct what they said.
      // The answer is open again, so switching back to speaking adds to it.
      voice.reopenAnswer();
      mergeIntoDraft(text);
      setTextMode(true);
      setErr(`${errorMessage(e)} — your answer was not sent. It's in the box below; press Send to try again.`);
      setPhase('listening');
    }
  };

  const voice = useVoiceAnswer({
    token, phaseRef, textModeRef, canCaptureRef, pausedRef, speechSeqRef, voiceHintRef, languageRef, setPhase, setTextMode, setInterim, setErr,
    submitAnswer: (text) => { void submitAnswer(text); },
    addNudge: (text) => { addMsg({ speaker: 'agent', text, nudge: true }); },
    mergeIntoDraft,
    onMicDead: () => { meterRef.current?.stop(); meterRef.current = null; setMicOpen(false); },
    // The pill follows capture itself, so it is back when speaking resumes.
    onCaptureStarted: () => setMicOpen(true),
  });
  const { beginListening } = voice;

  /** Put a question on screen as the one the next answer replies to. */
  function showQuestion(turn: AgentTurn, prefix: string, questionText = turn.text) {
    currentTurnRef.current = turn;
    setCurrentDone(turn.done);
    setCurrentAgent(questionText);
    setQuestionPrefix(prefix);
  }

  function sayAndListen(turn: AgentTurn, opts: { reveal?: string; resume?: boolean; prefix?: string } = {}) {
    speechSeqRef.current += 1;
    const seq = speechSeqRef.current;
    // A new question ends the previous answer; a repeat continues it.
    if (!opts.resume) voice.endAnswer();
    showQuestion(turn, opts.prefix ?? '');
    setRevealing(opts.reveal ? { id: opts.reveal, text: turn.text } : null);
    setPhase('speaking');
    void speakTurn({
      token, turnId: turn.turnId, text: turn.text, voiceHint: voiceHintRef.current,
      onDone: () => {
        // A repeat or a leave replaced this speech; its end is not ours.
        if (seq !== speechSeqRef.current) return;
        setRevealing(null);
        if (turn.done) {
          // Close the microphone at the end rather than at unmount. The capture
          // indicator disappears here, and it must disappear because capture has
          // actually stopped — not merely because the screen changed.
          meterRef.current?.stop();
          meterRef.current = null;
          setMicOpen(false);
          setWithdrawn(turn.withdrawn === true);
          setPhase('done');
          return;
        }
        // beginListening handles typed mode too, and it records when this
        // answer began; skipping it left typed answers without a start time.
        void beginListening({ resume: opts.resume });
      },
    });
  }

  function receiveTurn(turn: AgentTurn) {
    const id = addMsg({ speaker: 'agent', text: turn.text, final: turn.done });
    applyQuestionMode(turn.text);
    sayAndListen(turn, { reveal: id });
  }

  const begin = async () => {
    setErr('');
    startTimeRef.current = Date.now();
    setPhase('thinking');
    // Inside the Join click: browsers only let audio analysis start from a
    // user gesture.
    aiVoice.prime();
    // Requested here rather than on load: a permission prompt that appears
    // before the candidate has chosen to start reads as the page grabbing the
    // mic, and gets denied. Not requested at all without consent to capture.
    if (canCapture) {
      meterRef.current = await createMicMeter();
      setMicOpen(meterRef.current !== null);
    }
    try {
      // A rejoin on a live session also returns the conversation so far.
      rejoin.applyOpening(await api.post<StartResponse>(`/portal/${token}/start`, {}));
    } catch (e: unknown) {
      if (refusalOf(e) === 'finished') { showFinished(); return; }
      setErr(errorMessage(e));
      setPhase('ready');
    }
  };

  /**
   * The interview is already complete. Retrying would only meet the same
   * refusal, so the room closes the microphone and says so.
   */
  function showFinished() {
    speechSeqRef.current += 1;
    stopAllSpeech();
    voice.discardCapture();
    meterRef.current?.stop();
    meterRef.current = null;
    setMicOpen(false);
    setErr('');
    // The same words the portal shows for a finished interview.
    setCompletedNote(FINISHED_ENTRY.message);
    setPhase('done');
  }

  const rejoin = useRejoin({
    token,
    openOn: (res, lines, clockOffsetMs) => {
      // Set back so answers given now are stamped after everything on record.
      startTimeRef.current = Date.now() - clockOffsetMs;
      const opened = fromTranscript(lines, { fresh: res.resumed !== true });
      setMsgs(opened);
      lastOpenedIdRef.current = opened[opened.length - 1]?.id ?? '';
      applyQuestionMode(res.turn.text);
    },
    setAwaitingReply,
    showQuestion: (turn, prefix, text) => showQuestion(turn, prefix, text),
    sayAndListen: (turn, prefix) => {
      // Reveal the question as it is spoken when it is the newest line shown.
      sayAndListen(turn, { prefix, reveal: prefix ? undefined : lastOpenedIdRef.current });
    },
    beginListening: () => { void beginListening(); },
    thinking: () => setPhase('thinking'),
    showFinished,
    // Their words stay on screen: typing, and not switched away by the next question.
    keepAnswer: (text) => { answerMode.choose(); mergeIntoDraft(text); setTextMode(true); },
    setErr,
    reopenTurn: () => { voice.reopenAnswer(); setPhase('listening'); },
    stopAnswering: () => { voice.discardCapture(); voice.turnClosedRef.current = true; setInterim(''); },
    receiveTurn,
    currentTurnId: () => currentTurnRef.current?.turnId,
  });

  const { pause, resume, selectMode, repeat } = useAnswerControls({
    voice, answerMode, typed, setTyped, setInterim, setPaused, pausedRef, phaseRef, setPhase, speakUnavailableRef,
    replayQuestion: (continueAnswer) => {
      const turn = currentTurnRef.current;
      if (!turn) return;
      stopAllSpeech();
      sayAndListen(turn, { resume: continueAnswer });
    },
  });

  const leaving = useLeave({
    token, textModeRef, pausedRef, setPhase, setErr, showFinished,
    currentTurnDone: () => currentTurnRef.current?.done === true,
    holdCapture: voice.holdCapture,
    beginListening: voice.beginListening,
    answerInProgress: voice.answerInProgress,
    reopenAnswer: voice.reopenAnswer,
    clearReveal: () => setRevealing(null),
    showLeft: () => {
      // Ended from elsewhere (another tab): the room shows it has been left.
      speechSeqRef.current += 1;
      stopAllSpeech();
      voice.discardCapture();
      meterRef.current?.stop();
      meterRef.current = null;
      setMicOpen(false);
      setErr('');
      setWithdrawn(true);
      setPhase('done');
    },
    stopSpeech: () => { speechSeqRef.current += 1; stopAllSpeech(); },
    onLeft: (turn) => {
      voice.discardCapture();
      addMsg({ speaker: 'candidate', text: LEAVE_MARKER });
      setErr('');
      setAwaitingReply(false);
      receiveTurn(turn);
    },
  });
  const leave = () => { setLeaveOpen(false); void leaving.leave(); };

  const reveal = useMemo<RevealingMessage | null>(
    () => (revealing ? { id: revealing.id, spoken: () => aiVoice.spoken(revealing.text) } : null),
    [revealing, aiVoice],
  );
  const capturing = phase === 'listening' && !textMode && !paused;
  const capturingRef = useRef(capturing);
  capturingRef.current = capturing;
  const getCandidateLevel = useCallback(() => (capturingRef.current && meterRef.current ? meterRef.current.level() : 0), []);
  const getAiLevel = useCallback(() => aiVoice.level(), [aiVoice]);

  if (!info) return <RoomLoading err={err} />;

  // The name on screen is the interviewer this candidate was introduced to on
  // the consent screen, where they were told it is an AI. It carries no label,
  // as on a real call; the AI fact stays reachable beside what is captured.
  const header = interviewRoomHeader(info.persona);
  const interviewer = interviewerName(info.persona?.name);
  const interviewerBadge = { name: header.name, initial: header.initial };
  const aiFact = roomAiFact(info.persona?.name);
  const live = phase !== 'ready' && phase !== 'done';
  const canSend = phase === 'listening' && (textMode ? typed.trim().length > 0 : !paused && interim.trim().length > 0);

  return (
    <div className="room">
      <h1 className="visually-hidden">Your interview</h1>
      <RoomTopBar
        roleTitle={info.roleTitle}
        durationMinutes={info.durationMinutes}
        startedAt={phase === 'ready' ? 0 : startTimeRef.current}
        finished={phase === 'done'}
        question={questionNumber(msgs)}
        capture={live && micOpen ? { mode: textMode ? 'mic' : 'transcribing', stt: info.speech.stt, aiFact } : null}
        privacy={<RoomPrivacy aiFact={aiFact} stt={info.speech.stt} canCapture={canCapture} />}
        showActions={live}
        paused={paused}
        pauseAvailable={phase === 'listening'}
        leaveAvailable={leaving.available(phase === 'listening' || phase === 'speaking')}
        onPause={() => void pause()}
        onLeave={() => setLeaveOpen(true)}
      />
      <div className="room-body">
        <ParticipantsRail
          interviewer={interviewerBadge}
          candidate={{ name: info.candidateName, initial: initials(info.candidateName) }}
          aiStatus={aiStatus(phase, paused)}
          aiThinking={phase === 'thinking'}
          aiSpeaking={phase === 'speaking'}
          getAiLevel={getAiLevel}
          getCandidateLevel={getCandidateLevel}
          candidateStatus={(speakingNow) => candidateStatus({ phase, textMode, speakingNow })}
          observers={[]}
          privacy={<RoomPrivacy aiFact={aiFact} stt={info.speech.stt} canCapture={canCapture} />}
        />
        <ConversationPanel
          err={err}
          messages={msgs}
          interviewer={interviewerBadge}
          candidateInitials={initials(info.candidateName)}
          revealing={reveal}
        >
          {phase === 'ready' && (
            <div className="room-dock">
              <JoinPanel durationMinutes={info.durationMinutes} interviewer={interviewer} aiFact={aiFact} stt={info.speech.stt} canCapture={canCapture} onJoin={() => void begin()} />
              {!ttsSupported() && <p className="room-note">Your browser can't play synthesised speech — questions will appear as text.</p>}
            </div>
          )}
          {phase === 'done' && (
            <div className="room-dock">
              <DonePanel feedback={feedback} completedNote={completedNote} withdrawn={withdrawn} />
            </div>
          )}
          {live && (
            <Composer
              mode={mode}
              speakUnavailable={speakUnavailable}
              phase={phase}
              paused={paused}
              interviewerName={interviewer}
              capturing={capturing}
              interim={interim}
              typed={typed}
              canSend={canSend}
              currentQuestion={currentAgent}
              questionPrefix={questionPrefix}
              onContinue={phase === 'listening' && awaitingReply ? () => void rejoin.continueInterview() : null}
              repeatAvailable={phase === 'listening' || phase === 'speaking'}
              nudge={answerMode.nudge}
              getCandidateLevel={getCandidateLevel}
              onTypedChange={setTyped}
              onSelectMode={selectMode}
              onSend={() => (textMode ? void submitAnswer(typed, { code: codeMode }) : voice.doneAnswering())}
              onDoneSpeaking={voice.doneAnswering}
              onRepeat={() => void repeat()}
              onResume={resume}
            />
          )}
        </ConversationPanel>
      </div>
      <LeaveDialog open={leaveOpen} interviewer={interviewer} onCancel={() => setLeaveOpen(false)} onConfirm={leave} />
    </div>
  );
}
