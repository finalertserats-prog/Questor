import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, type SignInStep } from '../auth';
import { Banner } from './ui';

/**
 * Sign in to one organisation: password, then — when that organisation asks for
 * one — a six-digit code emailed to the address on the account.
 *
 * Both steps live here rather than in two pages because they are one errand.
 * A person who has typed their password and is waiting for a code has not
 * navigated anywhere; they are still signing in, and the ticket that carries
 * the half-finished state dies with this component. It is deliberately not
 * stored: a ticket in localStorage would outlive the page that earned it.
 */
export function SignInForm({ orgSlug, orgName }: { orgSlug: string; orgName: string }) {
  const { login, submitCode } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [step, setStep] = useState<SignInStep | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const next = await login(email, password, { orgSlug, rememberDevice: remember });
      // 'signed_in' navigates by itself: the route guard sends a signed-in user
      // off the sign-in page, so there is nothing to do here but stop.
      if (next.kind === 'code_sent') setStep(next);
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const submitTheCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!step || step.kind !== 'code_sent') return;
    setErr('');
    setBusy(true);
    try {
      await submitCode(step.pending, code);
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : 'That code was not accepted.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  /** Back to the password, which is also how a new code is asked for. */
  const startAgain = () => {
    setStep(null);
    setCode('');
    setPassword('');
    setErr('');
  };

  if (step?.kind === 'code_sent') {
    return (
      <>
        <p className="landing-eyebrow">Signing in to</p>
        <h1 className="landing-title">{orgName}</h1>
        <p className="muted small">
          We emailed a six-digit code to {step.destination}. It works once and expires in ten minutes.
        </p>
        {err && <Banner kind="error">{err}</Banner>}
        <form onSubmit={submitTheCode} noValidate>
          <label htmlFor="signin-code">Sign-in code</label>
          <input
            id="signin-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            // Six digits, on a phone keypad, offered by the OS from the SMS/email
            // autofill hint. `one-time-code` is what makes that work.
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            autoFocus
          />
          <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
            {busy ? 'Please wait…' : 'Sign in'}
          </button>
        </form>
        <div className="small muted" style={{ marginTop: 12, textAlign: 'center' }}>
          <button type="button" className="link-button" onClick={startAgain}>
            Didn't get it? Start again
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          If you did not just try to sign in, someone else has your password.{' '}
          <Link to={`/forgot-password?org=${encodeURIComponent(orgSlug)}`}>Reset it now</Link>.
        </p>
      </>
    );
  }

  return (
    <>
      <p className="landing-eyebrow">Signing in to</p>
      <h1 className="landing-title">{orgName}</h1>
      {err && <Banner kind="error">{err}</Banner>}
      <form onSubmit={submitPassword}>
        <label htmlFor="org-email">Email</label>
        <input id="org-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        <label htmlFor="org-password">Password</label>
        <input id="org-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        {/* Opt-in, and said plainly. Someone ticking this on a machine other
            people use is the failure this wording exists to prevent. */}
        <label className="check-row" htmlFor="remember-device">
          <input
            id="remember-device"
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Keep me signed in on this device for a week</span>
        </label>
        <p className="field-hint" id="remember-device-hint">
          Only on a device that is yours. It skips the emailed code — not your password — and ends
          if your password or your role changes. You can remove it in Settings at any time.
        </p>
        <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
          {busy ? 'Please wait…' : 'Sign in'}
        </button>
      </form>
      <div className="small muted" style={{ marginTop: 12, textAlign: 'center' }}>
        <Link to={`/forgot-password?org=${encodeURIComponent(orgSlug)}`}>Forgot your password?</Link>
      </div>
    </>
  );
}
