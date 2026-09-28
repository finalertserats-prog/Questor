import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Icon } from '../components/Icon';
import { Banner } from '../components/ui';
import { createRecognizer, sttSupported, type Recognizer } from '../speech';
import { MIC_DENIED_NOTICE, SPEECH_NOTICE, SPEECH_UNSUPPORTED_NOTICE, speechRoute } from '../components/demoInterviewModel';

/**
 * The last thing the demo asks: what did you think?
 *
 * SIGNED OUT BY DESIGN. "End demo" clears the session before this page is
 * reached, so the ticket in the address is the credential. That also means a
 * visitor who left the tab open can come back to it, and one who pressed End
 * demo in another tab is not locked out of answering.
 *
 * TYPING IS THE ROUTE. Speaking is offered where the browser has a recogniser,
 * and is never the only way in: recognition is missing on Firefox and Safari,
 * fails outright without a microphone, and on the browsers that do have it the
 * audio goes to Google. All three of those are stated before the button is
 * pressed rather than discovered after.
 */
export function DemoFeedback() {
  const { token = '' } = useParams();
  const [body, setBody] = useState('');
  const [listening, setListening] = useState(false);
  const [micDenied, setMicDenied] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [spoke, setSpoke] = useState(false);
  const recognizer = useRef<Recognizer | null>(null);
  const supported = useRef(sttSupported());

  useEffect(() => () => { recognizer.current?.abort(); }, []);

  const route = speechRoute({ supported: supported.current, micDenied });

  const toggleDictation = () => {
    if (listening) {
      recognizer.current?.stop();
      setListening(false);
      return;
    }
    const rec = createRecognizer({
      // Appended, never replacing: somebody who typed half an answer and then
      // spoke the rest must not lose the half they typed.
      onFinal: (text) => { setBody((prev) => (prev ? `${prev} ${text}`.trim() : text)); setSpoke(true); },
      onEnd: () => setListening(false),
      onError: (e) => {
        setListening(false);
        // 'not-allowed' and 'service-not-allowed' are the microphone being
        // refused. Anything else is left alone: the box still works.
        if (e === 'not-allowed' || e === 'service-not-allowed') setMicDenied(true);
      },
      onDead: () => { setListening(false); setMicDenied(true); },
    });
    if (!rec) { setMicDenied(true); return; }
    recognizer.current = rec;
    rec.start();
    setListening(true);
  };

  const send = async () => {
    if (busy || body.trim().length === 0) return;
    setBusy(true); setErr('');
    recognizer.current?.stop();
    try {
      await api.post('/demo-feedback', { token, body: body.trim(), source: spoke ? 'spoken' : 'typed' });
      setSent(true);
    } catch (error: unknown) {
      setErr(error instanceof ApiError && error.status === 410
        ? 'This feedback link has already been used. Thank you either way.'
        : 'We could not send that just now. Your words are still in the box.');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <main className="demo-feedback">
        <h1>Thank you</h1>
        <p>That goes straight to the person who builds this. Nothing else about your demo is kept beyond the seven days the sandbox lives.</p>
        <Link className="btn" to="/demo">Back to Questor</Link>
      </main>
    );
  }

  return (
    <main className="demo-feedback" aria-labelledby="demo-feedback-heading">
      <h1 id="demo-feedback-heading">What did you make of it?</h1>
      <p>
        Anything at all — what worked, what did not, what you expected and did not get. It is read by the person who
        builds Questor, not by a machine.
      </p>

      {err && <Banner kind="error">{err}</Banner>}

      <label htmlFor="demo-feedback-body">Your feedback</label>
      <textarea
        id="demo-feedback-body"
        className="demo-feedback-box"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        maxLength={4000}
        placeholder="The interviewer asked about…"
      />

      <div className="demo-feedback-speech">
        {route === 'offer' && (
          <>
            <button
              type="button"
              className={listening ? 'btn sm' : 'btn sm secondary'}
              onClick={toggleDictation}
              aria-pressed={listening}
            >
              <Icon name={listening ? 'stop' : 'mic'} size={15} />
              {listening ? 'Stop dictating' : 'Speak it instead'}
            </button>
            <p className="small muted">{SPEECH_NOTICE}</p>
          </>
        )}
        {route === 'unsupported' && <p className="small muted">{SPEECH_UNSUPPORTED_NOTICE}</p>}
        {route === 'denied' && <p className="small muted">{MIC_DENIED_NOTICE}</p>}
      </div>

      {/* Dictation is a thing happening that makes no sound and has no other
          non-visual signal, so it is announced — and only while it is on. */}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {listening ? 'Listening. What you say is added to the box; press Stop dictating when you are done.' : ''}
      </div>

      <button className="btn" onClick={() => void send()} disabled={busy || body.trim().length === 0}>
        {busy ? 'Sending…' : 'Send it'}
      </button>
      <p className="small muted">
        Your words are stored with this demo and deleted with it. They are never put to a language model.
      </p>
    </main>
  );
}
