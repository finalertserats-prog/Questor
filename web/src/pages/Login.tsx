import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Banner } from '../components/ui';
import { LandingHero } from '../components/LandingHero';

/** Organisation codes are lowercase letters, digits and hyphens. */
const ORG_CODE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function Login() {
  const { login, register, user } = useAuth();
  const nav = useNavigate();
  const [orgCode, setOrgCode] = useState('');
  const [showEmail, setShowEmail] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) nav('/');
  }, [user, nav]);

  const goToOrg = (e: React.FormEvent) => {
    e.preventDefault();
    const code = orgCode.trim().toLowerCase();
    if (!ORG_CODE.test(code)) {
      setErr('Organisation codes use lowercase letters, numbers and hyphens, like "acme-hiring".');
      return;
    }
    nav(`/o/${code}`);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register({ email, password, name, tenantName });
      nav('/');
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      {/* Decorative wash behind both columns; announced to nobody. */}
      <div className="landing-backdrop" aria-hidden="true" />
      <LandingHero />

      <section className="landing-panel">
        <div className="card auth-card">
          <div className="logo" style={{ fontSize: 26 }}>QUES<span>TOR</span></div>
          <div className="brand-line" aria-hidden="true" />
          <h1 className="landing-title">Sign in</h1>
          <p className="muted small">Use the sign-in link your organisation shared, or enter its code.</p>

          {err && <Banner kind="error">{err}</Banner>}

          <form onSubmit={goToOrg}>
            <label htmlFor="org-code">Organisation code</label>
            <input
              id="org-code"
              value={orgCode}
              onChange={(e) => setOrgCode(e.target.value)}
              placeholder="acme-hiring"
              autoCapitalize="none"
              autoComplete="organization"
              required
            />
            <button className="btn" style={{ width: '100%', marginTop: 14 }}>Continue</button>
          </form>

          <div className="landing-divider"><span>or</span></div>

          {!showEmail ? (
            <button type="button" className="btn secondary" style={{ width: '100%' }} onClick={() => setShowEmail(true)}>
              Sign in with email
            </button>
          ) : (
            <form onSubmit={submit}>
              {mode === 'register' && (
                <>
                  <label htmlFor="reg-name">Your name</label>
                  <input id="reg-name" value={name} onChange={(e) => setName(e.target.value)} required />
                  <label htmlFor="reg-org">Organisation name</label>
                  <input id="reg-org" value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="Acme Corp" />
                </>
              )}
              <label htmlFor="email">Email</label>
              <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              <label htmlFor="password">Password</label>
              <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
                {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create organisation'}
              </button>
            </form>
          )}

          {/* Self-registration is closed in production, so offering it there
              would only lead to an error. The seed credentials are a published
              default and are likewise shown only in development. */}
          {import.meta.env.DEV && showEmail && (
            <div className="small muted" style={{ marginTop: 12, textAlign: 'center' }}>
              {mode === 'login' ? (
                <button type="button" className="link-button" onClick={() => setMode('register')}>Set up a new organisation</button>
              ) : (
                <button type="button" className="link-button" onClick={() => setMode('login')}>Back to sign in</button>
              )}
              <div style={{ marginTop: 6 }}>Dev seed: <code>demo@questor.local</code> (run <code>npm run db:seed</code>)</div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
