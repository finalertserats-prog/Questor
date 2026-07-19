import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from '../components/ui';
import { speak, stopSpeaking, createRecognizer, sttSupported, ttsSupported, type Recognizer } from '../speech';

interface AgentTurn { turnId: string; text: string; competencyId: string; kind: string; done: boolean; }
interface Msg { speaker: 'agent' | 'candidate'; text: string; }

type Phase = 'ready' | 'speaking' | 'listening' | 'thinking' | 'done';

export function InterviewRoom() {
  const { token } = useParams();
  const [info, setInfo] = useState<any>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [currentAgent, setCurrentAgent] = useState('');
  const [interim, setInterim] = useState('');
  const [typed, setTyped] = useState('');
  const [textMode, setTextMode] = useState(false);
  const [err, setErr] = useState('');
  const recognizerRef = useRef<Recognizer | null>(null);
  const startTimeRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get(`/portal/${token}`).then((d: any) => { setInfo(d); if (!sttSupported()) setTextMode(true); }).catch((e) => setErr(e.message));
  }, [token]);

  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [msgs, interim]);

  const addMsg = (m: Msg) => setMsgs((prev) => [...prev, m]);

  const sayAndListen = (turn: AgentTurn) => {
    setCurrentAgent(turn.text);
    setPhase('speaking');
    speak(turn.text, () => {
      if (turn.done) { setPhase('done'); return; }
      if (textMode) { setPhase('listening'); return; }
      beginListening();
    });
  };

  const beginListening = () => {
    if (textMode) { setPhase('listening'); return; }
    setInterim('');
    setPhase('listening');
    const rec = createRecognizer({
      onInterim: (t) => setInterim(t),
      onFinal: (t) => submitAnswer(t),
      onError: (e) => { if (e !== 'no-speech') setErr(`Speech error: ${e}. You can type your answer instead.`); },
    });
    if (!rec) { setTextMode(true); setPhase('listening'); return; }
    recognizerRef.current = rec;
    rec.start();
  };

  const stopListeningAndSubmit = () => { recognizerRef.current?.stop(); };

  const submitAnswer = async (text: string) => {
    if (!text.trim()) return;
    recognizerRef.current?.abort();
    recognizerRef.current = null;
    setInterim(''); setTyped('');
    addMsg({ speaker: 'candidate', text });
    setPhase('thinking');
    const now = Date.now();
    const startMs = startTimeRef.current ? now - startTimeRef.current - 25000 : 0;
    try {
      const res = await api.post<{ turn: AgentTurn; assessmentReady?: boolean }>(`/portal/${token}/turn`, {
        text, startMs: Math.max(0, startMs), endMs: startTimeRef.current ? now - startTimeRef.current : 0,
      });
      addMsg({ speaker: 'agent', text: res.turn.text });
      sayAndListen(res.turn);
    } catch (e: any) { setErr(e.message); setPhase('listening'); }
  };

  const begin = async () => {
    setErr(''); startTimeRef.current = Date.now();
    setPhase('thinking');
    try {
      const res = await api.post<{ turn: AgentTurn }>(`/portal/${token}/start`, {});
      addMsg({ speaker: 'agent', text: res.turn.text });
      sayAndListen(res.turn);
    } catch (e: any) { setErr(e.message); setPhase('ready'); }
  };

  const repeat = () => { stopSpeaking(); recognizerRef.current?.abort(); speak(currentAgent, () => !textMode && beginListening()); };

  if (err && !info) return <div className="center-screen"><div className="card auth-card"><Banner kind="error">{err}</Banner></div></div>;
  if (!info) return <div className="center-screen muted">Loading interview room…</div>;

  const recording = !!info.recordingRequested;

  return (
    <div className="center-screen" style={{ alignItems: 'stretch', flexDirection: 'column', padding: 24, maxWidth: 760, margin: '0 auto' }}>
      <div className="row spread" style={{ marginBottom: 12 }}>
        <div className="logo" style={{ fontSize: 20, fontWeight: 800 }}>QUES<span style={{ color: 'var(--brand)' }}>TOR</span></div>
        <div className="row">
          {recording && phase !== 'ready' && phase !== 'done' && <span className="badge red">● Recording</span>}
          <span className="badge blue">{info.roleTitle}</span>
        </div>
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      <div className="card" style={{ textAlign: 'center', paddingTop: 26, paddingBottom: 22 }}>
        <div className={`mic-orb ${phase === 'listening' ? 'listening' : ''}`}>
          {phase === 'speaking' ? '🗣️' : phase === 'listening' ? '🎤' : phase === 'thinking' ? '…' : phase === 'done' ? '✓' : '🎙️'}
        </div>
        <div className="muted small" style={{ marginTop: 14 }}>
          {phase === 'ready' && 'Ready when you are.'}
          {phase === 'speaking' && 'Interviewer is speaking…'}
          {phase === 'listening' && (textMode ? 'Type your answer below.' : 'Listening… speak your answer, then click "I\'m done".')}
          {phase === 'thinking' && 'Thinking…'}
          {phase === 'done' && 'Interview complete. Thank you!'}
        </div>
      </div>

      {phase === 'ready' && (
        <button className="btn" style={{ width: '100%' }} onClick={begin}>Begin interview</button>
      )}

      {phase === 'listening' && !textMode && (
        <>
          {interim && <div className="card tight muted" style={{ fontStyle: 'italic' }}>{interim}</div>}
          <div className="row">
            <button className="btn" style={{ flex: 1 }} onClick={stopListeningAndSubmit}>I'm done answering</button>
            <button className="btn secondary" onClick={repeat}>Repeat question</button>
            <button className="btn ghost" onClick={() => setTextMode(true)}>Type instead</button>
          </div>
        </>
      )}

      {phase === 'listening' && textMode && (
        <div className="row">
          <textarea value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your answer…" style={{ flex: 1, minHeight: 70 }} onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) submitAnswer(typed); }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn" onClick={() => submitAnswer(typed)} disabled={!typed.trim()}>Send</button>
            <button className="btn secondary sm" onClick={repeat}>Repeat</button>
            {sttSupported() && <button className="btn ghost sm" onClick={() => setTextMode(false)}>Use voice</button>}
          </div>
        </div>
      )}

      {phase === 'done' && (
        <Banner kind="ok">Your interview is complete and has been submitted for human review. You may close this window. <a href="/">Return to Questor</a></Banner>
      )}

      <div className="card transcript" ref={scrollRef} style={{ marginTop: 16 }}>
        {msgs.length === 0 && <div className="muted small">The conversation transcript will appear here.</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`turn ${m.speaker}`}>
            <div className="who">{m.speaker === 'agent' ? 'Interviewer' : 'You'}</div>
            <div className="bubble">{m.text}</div>
          </div>
        ))}
        {interim && <div className="turn candidate"><div className="who">You (speaking)</div><div className="bubble muted">{interim}</div></div>}
      </div>

      {!ttsSupported() && <p className="small muted">Your browser doesn't support speech synthesis; questions are shown as text.</p>}
    </div>
  );
}
