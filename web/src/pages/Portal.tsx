import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from '../components/ui';
import { sttSupported, ttsSupported, speak } from '../speech';

interface PortalInfo {
  candidateName: string; roleTitle: string; state: string; durationMinutes: number;
  aiDisclosure: string; recordingRequested: boolean; privacy: string; accommodationsEnabled: boolean;
  speech: { stt: { provider: string }; tts: { provider: string } };
}

export function Portal() {
  const { token } = useParams();
  const nav = useNavigate();
  const [info, setInfo] = useState<PortalInfo | null>(null);
  const [err, setErr] = useState('');
  const [step, setStep] = useState<'review' | 'consent' | 'techcheck'>('review');
  const [recordingConsent, setRecordingConsent] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [accommodation, setAccommodation] = useState('');
  const [handoff, setHandoff] = useState('');
  const [mic, setMic] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<PortalInfo>(`/portal/${token}`).then(setInfo).catch((e) => setErr(e.message));
  }, [token]);

  const submitConsent = async () => {
    setErr(''); setBusy(true);
    try {
      const res = await api.post<{ handoff?: boolean; message?: string }>(`/portal/${token}/consent`, {
        recordingConsent, accepted, accommodationRequest: accommodation || undefined,
      });
      if (res.handoff) { setHandoff(res.message || 'Your request has been recorded.'); return; }
      setStep('techcheck');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const requestMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMic(true);
    } catch { setErr('Microphone permission is required for the voice interview.'); }
  };

  const testSpeaker = () => { speak('Audio check. If you can hear this clearly, your speaker is working.', () => setSpeaker(true)); };

  const finishTechCheck = async () => {
    await api.post(`/portal/${token}/techcheck`, { mic, speaker });
    nav(`/room/${token}`);
  };

  if (err && !info) return <div className="center-screen"><div className="card auth-card"><Banner kind="error">{err}</Banner></div></div>;
  if (!info) return <div className="center-screen muted">Loading…</div>;
  if (handoff) return <div className="center-screen"><div className="card auth-card"><Banner kind="ok">{handoff}</Banner></div></div>;

  return (
    <div className="center-screen">
      <div className="card" style={{ width: 560, maxWidth: '92vw' }}>
        <div className="logo" style={{ fontSize: 22, fontWeight: 800 }}>QUES<span style={{ color: 'var(--brand)' }}>TOR</span></div>
        <h2 style={{ marginTop: 8 }}>First-round interview: {info.roleTitle}</h2>
        <p className="muted small">Hello {info.candidateName}. This is an AI-conducted voice interview, about {info.durationMinutes} minutes.</p>
        {err && <Banner kind="error">{err}</Banner>}

        {step === 'review' && (
          <>
            <div className="card tight" style={{ background: 'var(--panel-2)' }}>
              <b>What to expect</b>
              <p className="small">{info.aiDisclosure}</p>
            </div>
            <div className="card tight" style={{ background: 'var(--panel-2)' }}>
              <b>Privacy</b>
              <p className="small">{info.privacy}</p>
            </div>
            {(!sttSupported() || !ttsSupported()) && (
              <Banner kind="info">For the best voice experience use Chrome or Edge. You can still complete the interview by typing your answers.</Banner>
            )}
            <button className="btn" style={{ width: '100%' }} onClick={() => setStep('consent')}>Continue</button>
          </>
        )}

        {step === 'consent' && (
          <>
            <label className="row" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" style={{ width: 'auto', marginTop: 4 }} checked={recordingConsent} onChange={(e) => setRecordingConsent(e.target.checked)} />
              <span>{info.recordingRequested ? 'I consent to this interview being recorded and transcribed.' : 'I consent to this interview being transcribed.'}</span>
            </label>
            <label className="row" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" style={{ width: 'auto', marginTop: 4 }} checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>I understand this first round is conducted by an AI interviewer and reviewed by a human, and I agree to proceed.</span>
            </label>
            {info.accommodationsEnabled && (
              <>
                <label>Need an accommodation or a human alternative? Describe it here (optional) and we'll route you to our team instead.</label>
                <textarea value={accommodation} onChange={(e) => setAccommodation(e.target.value)} placeholder="e.g. I need extra time, or I'd prefer a human interviewer" style={{ minHeight: 70 }} />
              </>
            )}
            <button className="btn" style={{ width: '100%', marginTop: 12 }} disabled={busy || (!accepted && !accommodation)} onClick={submitConsent}>
              {accommodation ? 'Submit accommodation request' : 'I consent — continue'}
            </button>
          </>
        )}

        {step === 'techcheck' && (
          <>
            <h3>Quick audio check</h3>
            <div className="row spread card tight" style={{ background: 'var(--panel-2)' }}>
              <span>🎤 Microphone {mic && <span className="badge green">ready</span>}</span>
              <button className="btn secondary sm" onClick={requestMic}>Enable mic</button>
            </div>
            <div className="row spread card tight" style={{ background: 'var(--panel-2)' }}>
              <span>🔊 Speaker {speaker && <span className="badge green">ok</span>}</span>
              <button className="btn secondary sm" onClick={testSpeaker}>Play test sound</button>
            </div>
            <button className="btn" style={{ width: '100%', marginTop: 12 }} onClick={finishTechCheck}>
              {mic && speaker ? 'Start interview →' : 'Continue anyway →'}
            </button>
            <p className="small muted" style={{ marginTop: 8 }}>You can ask the interviewer to repeat a question, request a pause, or type your answers at any time.</p>
          </>
        )}
      </div>
    </div>
  );
}
