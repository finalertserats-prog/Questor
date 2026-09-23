import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from '../components/ui';
import { LandingHero } from '../components/LandingHero';
import { BrandLogo } from '../components/BrandLogo';
import { ComplianceFooter } from '../components/ComplianceFooter';
import { forgotFormProblem, FORGOT_SENT_MESSAGE } from '../components/passwordModel';

/**
 * "I cannot sign in."
 *
 * The confirmation is the same sentence whether or not the address has an
 * account, and it is shown for a request that failed too — the page must not
 * become a way to ask who works somewhere. That is also why there is no
 * "we couldn't find that address" state to write: there is nothing this page is
 * allowed to know.
 */
export function ForgotPassword() {
  const [params] = useSearchParams();
  // Carried from an organisation's own sign-in page, so "Back to sign in"
  // returns to the door the person came in through rather than the front one.
  const slug = params.get('org') ?? '';
  const backTo = slug ? `/o/${encodeURIComponent(slug)}` : '/login';

  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = forgotFormProblem(email);
    if (bad) { setProblem(bad); return; }
    setProblem('');
    setBusy(true);
    try {
      await api.post('/auth/password/forgot', { email: email.trim() });
      setSent(true);
    } catch {
      // Even a refusal lands on the same confirmation. A rate limit or an
      // outage answered differently would say, to anyone watching, that this
      // particular address was worth limiting.
      setSent(true);
    } finally {
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

          {sent ? (
            <>
              <h1 className="landing-title">Check your email</h1>
              {/* A state the person must act on elsewhere, so a banner rather
                  than a toast — and an info banner, because nothing failed. */}
              <div role="status" aria-live="polite">
                <Banner kind="info">{FORGOT_SENT_MESSAGE}</Banner>
              </div>
              <Link className="btn secondary" style={{ width: '100%', marginTop: 14 }} to={backTo}>Back to sign in</Link>
              <p className="muted small" style={{ marginTop: 12 }}>
                Still stuck? Your Questor administrator can send you a link as well.
              </p>
            </>
          ) : (
            <>
              <h1 className="landing-title">Reset your password</h1>
              <p className="muted small">
                Enter the address you sign in with and we will email you a link to set a new password.
              </p>
              {problem && <Banner kind="error">{problem}</Banner>}
              <form onSubmit={submit} noValidate>
                <label htmlFor="forgot-email">Email</label>
                <input
                  id="forgot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  autoFocus
                />
                <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
                  {busy ? 'Please wait…' : 'Email me a link'}
                </button>
              </form>
              <div className="small muted" style={{ marginTop: 12, textAlign: 'center' }}>
                <Link to={backTo}>Back to sign in</Link>
              </div>
            </>
          )}
        </div>
      </section>
      <ComplianceFooter />
    </div>
  );
}
