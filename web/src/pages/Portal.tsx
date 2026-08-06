import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from '../components/ui';
import { sttSupported, ttsSupported, speak } from '../speech';

/** Mirrors SpeechCapability in server/src/providers/speech.ts. */
export interface SttCapability { provider: string; mode: 'browser' | 'server'; configured: boolean }

interface PortalInfo {
  candidateName: string; roleTitle: string; state: string; durationMinutes: number;
  aiDisclosure: string; recordingRequested: boolean; privacy: string; accommodationsEnabled: boolean;
  speech: { stt: SttCapability; tts: { provider: string } };
}

/**
 * Name every party that actually receives the candidate's voice.
 *
 * Naming only one would be a half-truth: InterviewRoom always starts the
 * browser's SpeechRecognition, which Chrome and Edge implement by streaming the
 * microphone to Google's speech servers rather than transcribing on the device,
 * AND records a local clip that is uploaded to the operator's own provider
 * whenever browser recognition returns nothing. Both can happen in one
 * interview, so both are disclosed.
 */
export function transcriptionProcessorSentence(stt: SttCapability): string {
  const browser =
    "Your browser's own speech recognition sends it away to be transcribed — in Chrome and Edge that means "
    + 'Google’s servers, not your own device.';
  if (stt.mode !== 'server' || !stt.configured) return browser;
  const vendor = stt.provider === 'whisper' ? 'OpenAI' : stt.provider;
  return `${browser} If that fails, the audio is sent to our own transcription provider, ${vendor}, instead.`;
}

/**
 * The four facts a candidate needs kept apart, because collapsing any two of
 * them misleads in one direction or the other.
 *
 * "You are being recorded" overstates it: no audio file exists at any point
 * after the text comes back (server/src/routes/portal.ts discards the upload,
 * and docs/BUILD_STATUS.md is explicit that the transcript is the artefact).
 * But "no audio is stored" understates it just as badly — the microphone really
 * is live and the audio really does leave the machine. Capture, processing,
 * storage and retention are therefore stated separately, in that order, so the
 * mental model a candidate leaves with is the correct one rather than the
 * reassuring one.
 *
 * Shared with InterviewRoom deliberately: the consent screen and the interview
 * itself must not be able to drift into describing this differently.
 */
export function VoiceHandling({ stt }: { stt: SttCapability }) {
  return (
    <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.55 }}>
      <li><b>Captured.</b> Your microphone is live while you answer, and your voice is captured in your browser.</li>
      <li><b>Processed by a third party.</b> {transcriptionProcessorSentence(stt)}</li>
      <li>
        <b>Not stored.</b> No audio file is kept — not by us, and not for playback. Each clip is discarded
        once the text comes back, so there is no recording of your voice for anyone to listen to later.
      </li>
      <li>
        <b>Retained.</b> The written transcript is kept. It is what the hiring team reads and what the AI
        scores — that text, not your voice, is the record of this interview.
      </li>
    </ul>
  );
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
              <b>What happens to your voice</b>
              <VoiceHandling stt={info.speech.stt} />
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
            {/* The old wording asked consent to "being recorded", which is not what
                happens — nothing records. Consent has to name the processing that
                is real, or it is consent to the wrong thing. The recordingRequested
                branch is gone with it: whether the employer ticked "recording" does
                not change any of the four facts below, so offering the candidate two
                different sentences only implied a difference that does not exist. */}
            <label className="row" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" style={{ width: 'auto', marginTop: 4 }} checked={recordingConsent} onChange={(e) => setRecordingConsent(e.target.checked)} />
              <span>
                I consent to my voice being captured while I answer and sent to a speech-to-text service
                to be transcribed, and to the resulting written transcript being kept and reviewed.
              </span>
            </label>
            <div className="card tight" style={{ background: 'var(--panel-2)' }}>
              <VoiceHandling stt={info.speech.stt} />
            </div>
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
