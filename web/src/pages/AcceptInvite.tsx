import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { LandingHero } from '../components/LandingHero';
import { BrandLogo } from '../components/BrandLogo';
import { ComplianceFooter } from '../components/ComplianceFooter';
import { useToast } from '../components/Toast';
import { tokenFromHash, newPasswordProblem, PASSWORD_HINT, PASSWORD_MIN_LENGTH } from '../components/passwordModel';
import { INVITE_DEAD_MESSAGE } from '../components/inviteModel';

type Check = 'checking' | 'usable' | 'dead' | 'unreachable';

interface Invitation {
  name?: string;
  email?: string;
  organisation?: string;
}

/**
 * Joining an organisation from an emailed invitation.
 *
 * The same shape as ResetPassword, and deliberately so: both are a person with
 * no session following a link out of their inbox, and both have exactly one
 * secret to look after. The token arrives in the URL fragment, which a browser
 * never sends to a server, so it is read here and put in a request body. It is
 * taken out of the address bar as soon as it has been read.
 *
 * Nobody but the person at this keyboard ever knows the password they type. An
 * admin who could choose it could sign in as them, and every action the account
 * took afterwards would be unattributable — which is the foundation the expert
 * review rests on (docs/credentials-contract.md §4).
 */
export function AcceptInvite() {
  const nav = useNavigate();
  const toast = useToast();
  /**
   * Read once, during the first render, before anything can take it away.
   *
   * Read inside the effect that clears it, React's development double-mount
   * would wipe the fragment on the first pass and declare a perfectly good
   * invitation dead on the second — the bug ResetPassword.tsx records, and the
   * same fix, because it is the same shape.
   */
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const [check, setCheck] = useState<Check>('checking');
  const [invitation, setInvitation] = useState<Invitation>({});
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setCheck('dead'); return undefined; }
    window.history.replaceState(null, '', window.location.pathname);

    let active = true;
    api.post<{ usable: boolean } & Invitation>('/auth/invite/check', { token })
      .then((data) => {
        if (!active) return;
        setCheck(data.usable ? 'usable' : 'dead');
        if (data.usable) setInvitation({ name: data.name, email: data.email, organisation: data.organisation });
      })
      // An outage is not a dead invitation, and telling someone their link has
      // expired sends them back to an admin to have a perfectly good one
      // replaced.
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
      await api.post('/auth/invite/accept', { token, password });
      toast.show('Your account is ready. Sign in with the password you just set.', { testId: 'invite-accepted' });
      nav('/login');
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Could not set your password.');
      setBusy(false);
    }
  };

  const greeting = invitation.name ? `Welcome, ${invitation.name.split(' ')[0]}` : 'Set your password';

  return (
    <div className="landing">
      <div className="landing-backdrop" aria-hidden="true" />
      <LandingHero />

      <section className="landing-panel">
        <div className="card auth-card">
          <BrandLogo variant="lockup" size={34} className="auth-logo" />
          <div className="brand-line" aria-hidden="true" />

          {check === 'checking' && <p className="muted small">Checking your invitation…</p>}

          {check === 'unreachable' && (
            <>
              <h1 className="landing-title">We can't reach Questor right now</h1>
              <Banner kind="error">
                Your invitation may well be fine — we simply could not check it. This is usually brief.
              </Banner>
              <button type="button" className="btn" style={{ width: '100%', marginTop: 14 }} onClick={() => window.location.reload()}>
                Try again
              </button>
              <Link className="btn secondary" style={{ width: '100%', marginTop: 8 }} to="/login">Back to sign in</Link>
            </>
          )}

          {check === 'dead' && (
            <>
              <h1 className="landing-title">This invitation has expired</h1>
              {/* The same sentence for expired, used, withdrawn and invented:
                  any difference would turn guessing at links into confirming
                  that an address was once invited. */}
              <Banner kind="error">{INVITE_DEAD_MESSAGE}</Banner>
              <Link className="btn secondary" style={{ width: '100%', marginTop: 14 }} to="/login">Back to sign in</Link>
            </>
          )}

          {check === 'usable' && (
            <>
              <h1 className="landing-title">{greeting}</h1>
              <p className="muted small">
                {invitation.organisation
                  ? <>You have been invited to join {invitation.organisation} on Questor as {invitation.email}.</>
                  : <>You have been invited to Questor as {invitation.email}.</>}
                {' '}Choose a password. Nobody else sets it, and nobody else sees it.
              </p>
              {problem && <Banner kind="error">{problem}</Banner>}
              <form onSubmit={submit} noValidate>
                <label htmlFor="invite-password">Password</label>
                <p className="field-hint" id="invite-password-hint">{PASSWORD_HINT}</p>
                <input
                  id="invite-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  aria-describedby="invite-password-hint"
                  minLength={PASSWORD_MIN_LENGTH}
                  autoFocus
                />
                <label htmlFor="invite-confirm">Repeat password</label>
                <input
                  id="invite-confirm"
                  type="password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  autoComplete="new-password"
                />
                <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
                  {busy ? 'Please wait…' : 'Set password and join'}
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
