import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { BrandLogo } from '../components/BrandLogo';
import { canRequestDemoAgain, demoReasonText } from '../components/demoModel';

function PublicBar() {
  return (
    <header className="public-bar">
      <Link to="/login" className="public-brand"><BrandLogo variant="lockup" size={28} /></Link>
      <Link to="/login" className="btn sm secondary">Sign in</Link>
    </header>
  );
}

export function DemoRedeem() {
  const { token = '' } = useParams();
  const [reason, setReason] = useState('');
  const [requested, setRequested] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const askingRef = useRef(false);

  const redeem = async () => {
    setBusy(true); setErr('');
    // A full load, so the app starts from the new session cookie rather than
    // the signed-out state it already holds (which would bounce to /login).
    try { await api.post('/demo/redeem', { token }); window.location.assign('/'); }
    catch (error: unknown) {
      if (error instanceof ApiError && error.status === 410) setReason(error.code ?? 'unknown');
      else setErr(error instanceof Error ? error.message : 'Could not open the demo.');
    } finally { setBusy(false); }
  };

  // Its failure used to be an unhandled rejection: the button did nothing and
  // said nothing. A ref as well as state so a double press sends one request.
  const reaccess = async () => {
    if (askingRef.current) return;
    askingRef.current = true;
    setAsking(true); setErr('');
    try {
      await api.post('/demo/reaccess', { token });
      setRequested(true);
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : 'Could not send your request. Try again.');
    } finally {
      askingRef.current = false;
      setAsking(false);
    }
  };

  return <div className="public-shell"><PublicBar /><main className="public-body"><div className="card auth-card" style={{ width: '100%', maxWidth: 520, margin: '0 auto' }}>
    <h1>Questor demo</h1>{err && <Banner kind="error">{err}</Banner>}
    {reason ? (
      <>
        <Banner kind="error">{demoReasonText(reason)}</Banner>
        {/* Only a used or expired link can be asked for again (the server's
            canRequestAgain); an unrecognised one leads to a new request instead. */}
        {!canRequestDemoAgain(reason)
          ? <p className="muted"><Link to="/demo">Ask for a new demo</Link> instead.</p>
          : requested
            ? <p className="muted" role="status">Thanks — we sent your request to the Questor team.</p>
            : <button type="button" className="btn" disabled={asking} onClick={() => void reaccess()}>{asking ? 'Sending…' : 'Request access again'}</button>}
      </>
    ) : (
      <><p className="muted">Open your private sandbox. The link is one-time use, so it will not be redeemed until you press the button.</p><button type="button" className="btn" disabled={busy} onClick={() => void redeem()}>{busy ? 'Opening…' : 'Start demo'}</button></>
    )}
  </div></main></div>;
}

/** Where a demo lands when it ends, by the button or the clock. */
export function DemoEnded() {
  return <div className="public-shell"><PublicBar /><main className="public-body"><div className="card auth-card" style={{ width: '100%', maxWidth: 520, margin: '0 auto' }}>
    <h1>Thanks for trying Questor</h1>
    <p className="muted">Your demo has ended and you have been signed out. Your sandbox is kept for a few days, then deleted.</p>
    <p>Want to see more, or talk through your hiring? <Link to="/signup">Ask for an account</Link> and we will be in touch.</p>
  </div></main></div>;
}
