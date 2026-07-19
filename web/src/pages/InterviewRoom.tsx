import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  speakTurn, stopAllSpeech, createRecognizer, createMicMeter,
  startRecording, transcribeOnServer,
  sttSupported, ttsSupported, type Recognizer, type MicMeter, type Recording,
} from '../speech';

// The interview room is the only screen a candidate ever sees, and it is the
// screen they judge the company by. It is deliberately built as a call surface
// — a stage with participants and a control bar — rather than as stacked cards:
// people already know how to be interviewed over a video call, and borrowing
// that grammar means nobody has to learn a new UI while also being assessed.

interface AgentTurn { turnId: string; text: string; competencyId: string; kind: string; done: boolean }
interface Msg { speaker: 'agent' | 'candidate'; text: string }
interface PortalInfo { candidateName: string; roleTitle: string; recordingRequested: boolean; durationMinutes: number }
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

export function InterviewRoom() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<PortalInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [currentAgent, setCurrentAgent] = useState('');
  const [currentTurnId, setCurrentTurnId] = useState('');
  const [interim, setInterim] = useState('');
  const [typed, setTyped] = useState('');
  const [textMode, setTextMode] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [micLevel, setMicLevel] = useState(0);
  const [err, setErr] = useState('');

  const recognizerRef = useRef<Recognizer | null>(null);
  const meterRef = useRef<MicMeter | null>(null);
  const recordingRef = useRef<Recording | null>(null);
  const recognizerFailedRef = useRef(false);
  const startTimeRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<PortalInfo>(`/portal/${token}`)
      .then((d) => { setInfo(d); if (!sttSupported()) setTextMode(true); })
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

  useEffect(() => () => { meterRef.current?.stop(); stopAllSpeech(); recognizerRef.current?.abort(); }, []);

  const addMsg = (m: Msg) => setMsgs((prev) => [...prev, m]);

  const submitAnswer = useCallback(async (text: string) => {
    if (!text.trim()) return;
    recognizerRef.current?.abort();
    recognizerRef.current = null;
    setInterim('');
    setPhase('thinking');
    const now = Date.now();
    const startMs = startTimeRef.current ? now - startTimeRef.current - 25000 : 0;
    try {
      const res = await api.post<{ turn: AgentTurn }>(`/portal/${token}/turn`, {
        text, startMs: Math.max(0, startMs), endMs: startTimeRef.current ? now - startTimeRef.current : 0,
      });
      // Only show the answer once the server has it. Showing it first made a
      // failed submit invisible: the candidate saw their answer sitting in the
      // transcript looking delivered while the server never received it, and
      // the text was already cleared so they could not resend it. A silent loss
      // that looks like success is the worst outcome in an interview.
      addMsg({ speaker: 'candidate', text });
      setTyped('');
      addMsg({ speaker: 'agent', text: res.turn.text });
      sayAndListen(res.turn);
    } catch (e) {
      // Keep the text so they can retry rather than reconstruct what they said.
      setTyped(text);
      setTextMode(true);
      setErr(`${(e as Error).message} — your answer was not sent. It's in the box below; press Send to try again.`);
      setPhase('listening');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const beginListening = useCallback(async () => {
    if (textMode) { setPhase('listening'); return; }
    setInterim('');
    setPhase('listening');

    // Always record. The recording is what gets transcribed if the browser's
    // own recognition fails — without it a `network` error loses the answer
    // outright and the candidate has to repeat themselves.
    recordingRef.current = await startRecording();

    const rec = createRecognizer({
      onInterim: setInterim,
      onFinal: (t) => void finishAnswer(t),
      onError: (e) => {
        if (e === 'no-speech') return;
        // Do not surface this as an error yet: if we captured audio, the server
        // can still transcribe it and the candidate never needs to know.
        recognizerFailedRef.current = true;
        if (!recordingRef.current) setErr(`Speech error: ${e}. You can type your answer instead.`);
      },
    });
    if (!rec) {
      // No browser recognition at all. Recording alone still works if the
      // server can transcribe; otherwise fall back to typing.
      if (!recordingRef.current) { setTextMode(true); setPhase('listening'); }
      return;
    }
    recognizerRef.current = rec;
    rec.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textMode]);

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
      const text = await transcribeOnServer(token, audio);
      setInterim('');
      if (text) { recognizerFailedRef.current = false; void submitAnswer(text); return; }
    }

    // Nothing usable from either path.
    setPhase('listening');
    setErr(recognizerFailedRef.current
      ? 'We could not hear that. Please try again, or type your answer instead.'
      : 'No speech detected. Please try again, or type your answer instead.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /** "Done answering" — stop recognition; finishAnswer runs on its end event. */
  const doneAnswering = () => {
    if (recognizerRef.current) recognizerRef.current.stop();
    else void finishAnswer('');
  };

  function sayAndListen(turn: AgentTurn) {
    setCurrentAgent(turn.text);
    setCurrentTurnId(turn.turnId);
    setPhase('speaking');
    void speakTurn({
      token, turnId: turn.turnId, text: turn.text,
      onDone: () => {
        if (turn.done) { setPhase('done'); return; }
        if (textMode) { setPhase('listening'); return; }
        beginListening();
      },
    });
  }

  const begin = async () => {
    setErr('');
    startTimeRef.current = Date.now();
    setPhase('thinking');
    // Requested here rather than on load: a permission prompt that appears
    // before the candidate has chosen to start reads as the page grabbing the
    // mic, and gets denied.
    meterRef.current = await createMicMeter();
    try {
      const res = await api.post<{ turn: AgentTurn }>(`/portal/${token}/start`, {});
      addMsg({ speaker: 'agent', text: res.turn.text });
      sayAndListen(res.turn);
    } catch (e) { setErr((e as Error).message); setPhase('ready'); }
  };

  const repeat = () => {
    stopAllSpeech();
    recognizerRef.current?.abort();
    void speakTurn({ token, turnId: currentTurnId, text: currentAgent, onDone: () => { if (!textMode) beginListening(); } });
  };

  if (err && !info) return <div className="center-screen"><div className="card auth-card"><div className="banner error">{err}</div></div></div>;
  if (!info) return <div className="center-screen muted">Connecting to the interview room…</div>;

  const live = phase !== 'ready' && phase !== 'done';
  const speaking = phase === 'speaking';
  const listening = phase === 'listening' && !textMode;

  return (
    <div className="room">
      <header className="room-bar">
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <span className="logo">QUES<span style={{ color: 'var(--brand)' }}>TOR</span></span>
          <span className="room-role">{info.roleTitle}</span>
        </div>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          {info.recordingRequested && live && <span className="rec-pill"><i />REC</span>}
          <span className="room-timer"><Elapsed since={startTimeRef.current} /></span>
        </div>
      </header>

      <main className="stage">
        <div className={`tile ${speaking ? 'is-active' : ''}`}>
          <SpeakingRings active={speaking} level={0.35} />
          <div className="tile-avatar agent-avatar">A</div>
          <div className="tile-name">Schranders <span className="tile-tag">AI interviewer</span></div>
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

      {captionsOn && (currentAgent || interim) && phase !== 'ready' && (
        <div className="captions">
          {listening && interim
            ? <p><span className="cap-who">You</span>{interim}</p>
            : <p><span className="cap-who">Schranders</span>{currentAgent}</p>}
        </div>
      )}

      {err && <div className="room-error">{err}</div>}

      <footer className="controls">
        {phase === 'ready' && (
          <div className="join-panel">
            <p className="muted">
              {info.durationMinutes} minutes · voice or typed · you can ask Schranders to repeat anything.
            </p>
            <button className="btn btn-join" onClick={begin}>Join interview</button>
          </div>
        )}

        {listening && (
          <>
            <button className="ctl" onClick={repeat}>↻<span>Repeat</span></button>
            <button className="ctl" onClick={() => setCaptionsOn((c) => !c)}>CC<span>{captionsOn ? 'On' : 'Off'}</span></button>
            <button className="btn btn-done" onClick={doneAnswering}>Done answering</button>
            <button className="ctl" onClick={() => setTextMode(true)}>⌨<span>Type</span></button>
            <button className="ctl" onClick={() => setShowTranscript((s) => !s)}>☰<span>Transcript</span></button>
          </>
        )}

        {phase === 'listening' && textMode && (
          <div className="type-row">
            <textarea
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type your answer, then Send… (Ctrl+Enter)"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitAnswer(typed); }}
            />
            <div className="type-actions">
              <button className="btn btn-done" onClick={() => void submitAnswer(typed)} disabled={!typed.trim()}>Send</button>
              {sttSupported() && <button className="ctl" onClick={() => setTextMode(false)}>🎤<span>Voice</span></button>}
            </div>
          </div>
        )}

        {(speaking || phase === 'thinking') && (
          <div className="controls-hint">
            <span>{speaking ? 'Listen to the question…' : 'One moment…'}</span>
            {speaking && <button className="ctl" onClick={repeat}>↻<span>Repeat</span></button>}
          </div>
        )}

        {phase === 'done' && (
          <div className="done-panel">
            <h3>That's everything — thank you.</h3>
            <p className="muted">
              Your interview has been submitted for human review. A person on the hiring team reads the
              transcript and makes the decision. You can close this window.
            </p>
          </div>
        )}
      </footer>

      <aside className={`transcript-panel ${showTranscript ? 'open' : ''}`}>
        <div className="row spread" style={{ marginBottom: 10 }}>
          <strong>Transcript</strong>
          <button className="ctl" onClick={() => setShowTranscript(false)}>✕</button>
        </div>
        <div className="transcript-scroll" ref={scrollRef}>
          {msgs.length === 0 && <p className="muted small">The conversation will appear here as you go.</p>}
          {msgs.map((m, i) => (
            <div key={i} className={`turn ${m.speaker}`}>
              <div className="who">{m.speaker === 'agent' ? 'Schranders' : 'You'}</div>
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
