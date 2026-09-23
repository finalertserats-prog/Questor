import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from '../components/ui';
import { LandingHero } from '../components/LandingHero';
import { BrandLogo } from '../components/BrandLogo';
import { ComplianceFooter } from '../components/ComplianceFooter';
import { useToast } from '../components/Toast';
import {
  tokenFromHash, newPasswordProblem, PASSWORD_HINT, PASSWORD_MIN_LENGTH, LINK_DEAD_MESSAGE,
} from '../components/passwordModel';

type Check = 'checking' | 'usable' | 'dead';

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
  const [token, setToken] = useState('');
  const [check, setCheck] = useState<Check>('checking');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const found = tokenFromHash(window.location.hash);
    setToken(found);
    if (!found) { setCheck('dead'); return; }
    // Cleared from the address bar once it is in memory. replaceState rather
    // than a navigation, so the page is not remounted and the token is not
    // pushed onto the history stack a second time.
    window.history.replaceState(null, '', window.location.pathname);

    let active = true;
    api.post<{ usable: boolean }>('/auth/password/reset/check', { token: found })
      .then((data) => { if (active) setCheck(data.usable ? 'usable' : 'dead'); })
      // An outage is not a dead link, but there is nothing useful to offer
      // here either: the form would only fail on submit. Say the same thing.
      .catch(() => { if (active) setCheck('dead'); });
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
