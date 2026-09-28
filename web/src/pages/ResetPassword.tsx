import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { LandingHero } from '../components/LandingHero';
import { BrandLogo } from '../components/BrandLogo';
import { ComplianceFooter } from '../components/ComplianceFooter';
import { useToast } from '../components/Toast';
import {
  tokenFromHash, newPasswordProblem, PASSWORD_HINT, PASSWORD_MIN_LENGTH, LINK_DEAD_MESSAGE,
} from '../components/passwordModel';

type Check = 'checking' | 'usable' | 'dead' | 'unreachable';

/**
 * Setting a new password from a link.
 *
 * The token arrives in the URL fragment, which the browser never sends to a
 * server — so it is read here and put in a request body. It is also taken out
 * of the address bar as soon as it has been read, so it does not survive in
 * browser history or get shoulder-read on a shared machine.
 */
export function ResetPassword() {
  const nav = useNavigate();
  const toast = useToast();
  /**
   * Read once, during the first render, before anything can take it away.
   *
   * It used to be read inside the effect that clears it — and React runs an
   * effect twice on mount in development. The first pass read the token and
   * wiped the hash; the second pass found an empty hash and declared a
   * perfectly good link expired. The person was then told to ask for another,
   * spending one of the five they get an hour, and the real link stayed live
   * in their inbox looking broken.
   *
   * A useState initialiser runs once per mounted component, so the token
   * survives the second pass. Reading a value and destroying its source in the
   * same breath is the shape of the bug; this separates them.
   */
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const [check, setCheck] = useState<Check>('checking');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setCheck('dead'); return undefined; }
    // Cleared from the address bar once it is in memory, so it does not sit in
    // browser history on a shared machine. replaceState rather than a
    // navigation, so the page is not remounted and the token is not pushed
    // onto the history stack a second time.
    window.history.replaceState(null, '', window.location.pathname);

    let active = true;
    api.post<{ usable: boolean }>('/auth/password/reset/check', { token })
      .then((data) => { if (active) setCheck(data.usable ? 'usable' : 'dead'); })
      // An outage is not a dead link, and saying it is sends the person to
      // burn one of the five links they get an hour on a link that was fine.
      // Nothing here says whose link it is either way, so there is no reason
      // to hide which of the two happened.
      .catch((error: unknown) => {
        if (!active) return;
        const status = error instanceof ApiError ? error.status : -1;
        setCheck(status === 0 || status >= 500 ? 'unreachable' : 'dead');
      });
    return () => { active = false; };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = newPasswordProblem(password, confirmation);
    if (bad) { setProblem(bad); return; }
    setProblem('');
    setBusy(true);
    try {
      await api.post('/auth/password/reset', { token, password });
      // Done and nothing left to do here, so a toast; the sign-in page it lands
      // on is the next thing rather than a state to read.
      toast.show('Password set. Sign in with your new password.', { testId: 'reset-done' });
      nav('/login');
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Could not set your password.');
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <div className="landing-backdrop" aria-hidden="true" />
      <LandingHero />

      <section className="landing-panel">
        <div className="card auth-card">
          <BrandLogo variant="lockup" size={34} className="auth-logo" />
          <div className="brand-line" aria-hidden="true" />

          {check === 'checking' && <p className="muted small">Checking your link…</p>}

          {check === 'unreachable' && (
            <>
              <h1 className="landing-title">We can't reach Questor right now</h1>
              {/* Deliberately not "this link has expired": a person told that
                  asks for a new one, spending one of the five they get an hour
                  on a link that was never the problem. */}
              <Banner kind="error">
                Your link may well be fine — we simply could not check it. This is usually brief.
              </Banner>
              <button type="button" className="btn" style={{ width: '100%', marginTop: 14 }} onClick={() => window.location.reload()}>
                Try again
              </button>
              <Link className="btn secondary" style={{ width: '100%', marginTop: 8 }} to="/login">Back to sign in</Link>
            </>
          )}

          {check === 'dead' && (
            <>
              <h1 className="landing-title">This link has expired</h1>
              {/* Something to act on, so a banner. The wording is identical for
                  an expired link, a used one and one that never existed: any
                  difference would say whose links are real. */}
              <Banner kind="error">{LINK_DEAD_MESSAGE}</Banner>
              <Link className="btn" style={{ width: '100%', marginTop: 14 }} to="/forgot-password">Ask for a new link</Link>
              <Link className="btn secondary" style={{ width: '100%', marginTop: 8 }} to="/login">Back to sign in</Link>
            </>
          )}

          {check === 'usable' && (
            <>
              <h1 className="landing-title">Set a new password</h1>
              <p className="muted small">
                This link works once. Setting a password signs you out of every other browser.
              </p>
              {problem && <Banner kind="error">{problem}</Banner>}
              <form onSubmit={submit} noValidate>
                <label htmlFor="reset-password">New password</label>
                <p className="field-hint" id="reset-password-hint">{PASSWORD_HINT}</p>
                <input
                  id="reset-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  aria-describedby="reset-password-hint"
                  minLength={PASSWORD_MIN_LENGTH}
                  autoFocus
                />
                <label htmlFor="reset-confirm">Repeat new password</label>
                <input
                  id="reset-confirm"
                  type="password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  autoComplete="new-password"
                />
                <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
                  {busy ? 'Please wait…' : 'Set password'}
                </button>
              </form>
              <div className="small muted" style={{ marginTop: 12, textAlign: 'center' }}>
                <Link to="/login">Back to sign in</Link>
              </div>
            </>
          )}
        </div>
      </section>
      <ComplianceFooter />
    </div>
  );
}
