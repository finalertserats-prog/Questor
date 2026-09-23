import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { sttSupported, ttsSupported, speak } from '../speech';
import { Icon } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';
import { Skeleton } from '../components/Skeleton';
import { accommodationHint, canSubmitConsent, consentAction } from '../components/portalConsentModel';
import { entryFromRefusal, portalEntry, type PortalEntry } from '../components/portalEntryModel';
import { aiAcknowledgement, splitDisclosure, whatHappensFirst } from '../components/interviewerModel';
import { earlyStartNote } from '../components/portalEarlyStartModel';
import { IdentityCodeStep } from '../components/IdentityCodeStep';
import { consentIdentityLine, needsIdentityCode, stepAfterConsent, type PortalIdentity } from '../components/identityCodeModel';
import { CandidateStatus } from './CandidateStatus';

/** Mirrors SpeechCapability in server/src/providers/speech.ts. */
export interface SttCapability { provider: string; mode: 'browser' | 'server'; configured: boolean }

interface PortalInfo {
  candidateName: string; roleTitle: string; state: string; durationMinutes: number;
  aiDisclosure: string; recordingRequested: boolean; privacy: string; accommodationsEnabled: boolean; proctoringEnabled: boolean;
  /** True when the disclosure says a member of the hiring team may observe. */
  observerNotice?: boolean;
  /** Whether this candidate consented to voice capture; absent on an older server. */
  recordingConsented?: boolean;
  /** Whether consent to the interview is on record; absent on an older server. */
  consented?: boolean;
  speech: { stt: SttCapability; tts: { provider: string } };
  /** The interviewer's name; absent on an older server. */
  persona?: { name: string | null } | null;
  /** When the interview is booked for, already written in the zone it was booked in; absent on an older server. */
  schedule?: { at: string; timeZone: string | null; text: string } | null;
  /** The one-time code asked for after consent; absent on an older server. */
  identity?: PortalIdentity;
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
  const [step, setStep] = useState<'review' | 'consent' | 'identity' | 'techcheck'>('review');
  // Unticked until the candidate ticks it. A pre-ticked consent box is not a
  // consent box, and the server records exactly what this holds.
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [accommodation, setAccommodation] = useState('');
  const [handoff, setHandoff] = useState('');
  const [mic, setMic] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set when a button press tells us the interview has moved on since this page
  // loaded; it overrides the state the page was opened with.
  const [refusedEntry, setRefusedEntry] = useState<PortalEntry | null>(null);
  // True once a button press has swapped the form for a card. Focus then moves
  // to the card's heading: the button the candidate pressed is gone, and focus
  // left on nothing strands a keyboard or screen-reader user at the top of the
  // page with no announcement of what changed.
  const [swappedByPress, setSwappedByPress] = useState(false);
  // The invitation no longer resolves to an interview to join. The status
  // page takes over: it is the same link, and it can still say where things
  // stand even when this one cannot.
  const [linkClosed, setLinkClosed] = useState(false);
  const cardHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (swappedByPress) cardHeadingRef.current?.focus(); }, [swappedByPress]);
  // The same reason, one step earlier in the journey: the one-time code step
  // replaces itself with the audio check, and the field the candidate had just
  // typed into disappears. Without this, focus fell back to the page body and a
  // screen-reader user heard nothing about what had changed — they were told
  // their code was accepted by a screen they had to go looking for.
  const techCheckHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (step === 'techcheck') techCheckHeadingRef.current?.focus(); }, [step]);

  useEffect(() => {
    api.get<PortalInfo>(`/portal/${token}`).then((loaded) => {
      setInfo(loaded);
      // Agreed already but the code is still owed (back from the room, or a
      // reload on the code step): straight to the code, not the whole journey again.
      if (loaded.consented === true && needsIdentityCode(loaded.identity)) setStep('identity');
    }).catch((e: unknown) => {
      // 404 and 410 are not errors here: an invitation that has been erased,
      // expired or spent still has a status page behind it, and that page
      // answers those cases in its own words. Anything else is a real failure.
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) { setLinkClosed(true); return; }
      setErr(e instanceof Error ? e.message : 'We could not load your interview details.');
    });
  }, [token]);

  const action = consentAction({ accepted, accommodation });

  /**
   * A refused consent or audio check usually means this page is stale: the
   * interview started or finished in another tab or on another device. Show
   * the screen for where the interview actually is, not a red error about a
   * form that no longer applies.
   */
  const handleRefusal = async (e: unknown, fallback: string) => {
    const status = e instanceof ApiError ? e.status : undefined;
    const message = e instanceof Error ? e.message : fallback;
    const entry = entryFromRefusal(status, message);
    if (entry) { setRefusedEntry(entry); setSwappedByPress(true); return; }
    if (status === 409) {
      try {
        const fresh = await api.get<PortalInfo>(`/portal/${token}`);
        if (portalEntry(fresh.state, fresh.consented === true).kind !== 'journey') {
          setInfo(fresh);
          setSwappedByPress(true);
          return;
        }
      } catch {
        // The re-read is a courtesy; the original refusal is still the answer.
      }
    }
    setErr(message);
  };

  const submitConsent = async () => {
    if (!canSubmitConsent({ accepted, accommodation, busy })) return;
    setErr(''); setBusy(true);
    try {
      const res = await api.post<{ handoff?: boolean; message?: string; identity?: PortalIdentity }>(`/portal/${token}/consent`, {
        recordingConsent, accepted, accommodationRequest: accommodation || undefined,
        monitoringNoticeShown: info?.proctoringEnabled === true,
        observerNoticeShown: info?.observerNotice === true,
      });
      if (res.handoff) { setHandoff(res.message || 'Your request has been recorded.'); return; }
      // The check the server just recorded, not the preview the page loaded
      // with: a setting or mail delivery may have changed in between.
      const identity = res.identity ?? info?.identity;
      if (info && res.identity) setInfo({ ...info, identity: res.identity });
      setStep(stepAfterConsent(identity));
    } catch (e: unknown) {
      await handleRefusal(e, 'We could not record your answer. Please try again.');
    } finally { setBusy(false); }
  };

  const requestMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMic(true);
    } catch { setErr('Microphone permission is required for the voice interview.'); }
  };

  const testSpeaker = () => { speak('Audio check. If you can hear this clearly, your speaker is working.', () => setSpeaker(true)); };

  // A failed tech check used to reject silently: the button did nothing, twice,
  // and the candidate had no idea why they were still on this screen.
  const finishTechCheck = async () => {
    if (busy) return;
    setErr(''); setBusy(true);
    try {
      await api.post(`/portal/${token}/techcheck`, { mic, speaker });
      nav(`/room/${token}`);
    } catch (e: unknown) {
      await handleRefusal(e, 'We could not start your interview. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (linkClosed && token) return <CandidateStatus token={token} />;
  if (err && !info) return <main className="center-screen"><div className="card auth-card"><Banner kind="error">{err}</Banner></div></main>;
  if (!info) {
    return (
      <main className="center-screen">
        <div className="card" style={{ width: 560, maxWidth: '92vw' }}>
          <Skeleton lines={6} label="Loading your interview details…" />
        </div>
      </main>
    );
  }
  if (handoff) return <main className="center-screen"><div className="card auth-card"><Banner kind="ok">{handoff}</Banner></div></main>;

  const entry = refusedEntry ?? portalEntry(info.state, info.consented === true);
  // Past the interview, the invitation link is no longer an invitation: it is
  // the candidate's status page. The card below stays for the one state that
  // still has something to DO — rejoining an interview in progress.
  if (token && (entry.kind === 'finished' || entry.kind === 'closed')) {
    return <CandidateStatus token={token} takeFocus={swappedByPress} />;
  }
  if (entry.kind !== 'journey') {
    return (
      <main className="center-screen">
        <div className="card" style={{ width: 560, maxWidth: '92vw' }}>
          <BrandLogo variant="lockup" size={26} className="candidate-logo" />
          <h1 style={{ marginTop: 8 }}>First-round interview: {info.roleTitle}</h1>
          <p className="muted small">Hello {info.candidateName}.</p>
          <h2 ref={cardHeadingRef} tabIndex={-1}>{entry.title}</h2>
          <Banner kind={entry.kind === 'closed' ? 'info' : 'ok'}>{entry.message}</Banner>
          {entry.kind === 'rejoin' && (
            <button className="btn" style={{ width: '100%', marginTop: 12 }} onClick={() => nav(`/room/${token}`)}>
              {entry.action}<Icon name="arrow-right" size={16} />
            </button>
          )}
        </div>
      </main>
    );
  }

  // The journey (first visit, not yet consented): the AI disclosure is shown
  // here, before the interview, naming the interviewer.
  const interviewer = info.persona?.name ?? null;
  const earlyNote = earlyStartNote(info.schedule, new Date());
  const disclosure = splitDisclosure(info.aiDisclosure);

  return (
    <main className="center-screen">
      <div className="card" style={{ width: 560, maxWidth: '92vw' }}>
        {/* Candidate-facing: the lockup is kept small; the interview is the subject. */}
        <BrandLogo variant="lockup" size={26} className="candidate-logo" />
        <h1 style={{ marginTop: 8 }}>First-round interview: {info.roleTitle}</h1>
        <p className="muted small">Hello {info.candidateName}. This is an AI-conducted voice interview, about {info.durationMinutes} minutes.</p>
        {info.schedule && <p className="small" data-testid="portal-schedule"><b>Booked for:</b> {info.schedule.text}</p>}
        {err && <Banner kind="error">{err}</Banner>}

        {step === 'review' && (
          <>
            {/* The AI disclosure lives here, before the interview, and not in
                the spoken opening: the interview itself opens like a real one.
                The interviewer line is lifted out so it cannot be missed; the
                whole text is still what the consent record stores. */}
            <div className="card tight" style={{ background: 'var(--panel-2)' }} data-testid="what-to-expect">
              <b className="check-label"><Icon name="about" size={16} />What to expect</b>
              {disclosure.intro && <p className="interviewer-notice" data-testid="interviewer-notice">{disclosure.intro}</p>}
              {disclosure.rest && <p className="small">{disclosure.rest}</p>}
              <p className="small">{whatHappensFirst(interviewer)}</p>
            </div>
            <div className="card tight" style={{ background: 'var(--panel-2)' }}>
              <b className="check-label"><Icon name="mic" size={16} />What happens to your voice</b>
              <VoiceHandling stt={info.speech.stt} />
            </div>
            <div className="card tight" style={{ background: 'var(--panel-2)' }}>
              <b className="check-label"><Icon name="lock" size={16} />Privacy</b>
              <p className="small">{info.privacy}</p>
            </div>
            {(!sttSupported() || !ttsSupported()) && (
              <Banner kind="info">For the best voice experience use Chrome or Edge. You can still complete the interview by typing your answers.</Banner>
            )}
            <button className="btn" style={{ width: '100%' }} onClick={() => setStep('consent')}>Continue<Icon name="arrow-right" size={16} /></button>
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
            <label className="check-row">
              <input type="checkbox" checked={recordingConsent} onChange={(e) => setRecordingConsent(e.target.checked)} />
              <span>
                I consent to my voice being captured while I answer and sent to a speech-to-text service
                to be transcribed, and to the resulting written transcript being kept and reviewed.
              </span>
            </label>
            {/* Declining is a real option with a real consequence, stated
                plainly: it changes how the interview is answered, it does not
                take the interview away. */}
            <p className="small muted" style={{ margin: '4px 0 0 26px' }}>
              If you leave this unticked you will type your answers instead of speaking them.
            </p>
            <div className="card tight" style={{ background: 'var(--panel-2)' }}>
              <VoiceHandling stt={info.speech.stt} />
            </div>
            <label className="check-row">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>{aiAcknowledgement(interviewer)}</span>
            </label>
            {/* Said before the candidate agrees, so the code step is never a surprise. */}
            {consentIdentityLine(info.identity) && (
              <p className="small muted" style={{ margin: '4px 0 0 26px' }} data-testid="consent-identity-line">{consentIdentityLine(info.identity)}</p>
            )}
            {info.accommodationsEnabled && (
              <>
                <label htmlFor="accommodation">Need an accommodation or a human alternative? Describe it here (optional) and we'll route you to our team instead.</label>
                <textarea id="accommodation" value={accommodation} onChange={(e) => setAccommodation(e.target.value)} placeholder="e.g. I need extra time, or I'd prefer a human interviewer" style={{ minHeight: 70 }} />
                {/* Said before the press, not after a rejection: a request under
                    the server's minimum used to be posted, dropped, and the
                    candidate moved on as though they had never asked. */}
                <p className="small muted" style={{ marginTop: 4 }}>{accommodationHint(accommodation)}</p>
              </>
            )}
            <button
              className="btn"
              style={{ width: '100%', marginTop: 12 }}
              disabled={!canSubmitConsent({ accepted, accommodation, busy })}
              onClick={submitConsent}
            >
              <Icon name={action === 'accommodation' ? 'send' : 'check-circle'} size={16} />
              {action === 'accommodation' ? 'Submit accommodation request' : 'I consent — continue'}
            </button>
          </>
        )}

        {step === 'identity' && info.identity && token && (
          <IdentityCodeStep
            token={token}
            identity={info.identity}
            onVerified={() => {
              setInfo({ ...info, identity: { ...info.identity!, verified: true } });
              setStep('techcheck');
            }}
          />
        )}

        {step === 'techcheck' && (
          <>
            <h3 ref={techCheckHeadingRef} tabIndex={-1}>Quick audio check</h3>
            <div className="row spread card tight" style={{ background: 'var(--panel-2)' }}>
              <span className="check-label">
                <Icon name="mic" size={16} />Microphone
                {mic && <span className="badge green status-badge"><Icon name="check" size={13} />ready</span>}
              </span>
              <button className="btn secondary sm" onClick={requestMic}><Icon name="mic" size={14} />Enable mic</button>
            </div>
            <div className="row spread card tight" style={{ background: 'var(--panel-2)' }}>
              <span className="check-label">
                <Icon name="speaker" size={16} />Speaker
                {speaker && <span className="badge green status-badge"><Icon name="check" size={13} />ok</span>}
              </span>
              <button className="btn secondary sm" onClick={testSpeaker}><Icon name="speaker" size={14} />Play test sound</button>
            </div>
            {/* Early is fine: the booked time is stated, starting is never blocked. */}
            {earlyNote && <p className="small" style={{ marginTop: 12 }} data-testid="portal-early-start">{earlyNote}</p>}
            <button className="btn" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={finishTechCheck}>
              {busy ? 'Starting…' : mic && speaker ? 'Start interview' : 'Continue anyway'}<Icon name="arrow-right" size={16} />
            </button>
            <p className="small muted" style={{ marginTop: 8 }}>You can ask the interviewer to repeat a question, request a pause, or type your answers at any time.</p>
          </>
        )}
      </div>
    </main>
  );
}
