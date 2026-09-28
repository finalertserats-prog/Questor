import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Banner } from '../components/ui';
import { LandingHero } from '../components/LandingHero';
import { BrandLogo } from '../components/BrandLogo';
import { ComplianceFooter } from '../components/ComplianceFooter';
import { OrgPicker } from '../components/OrgPicker';
import { orgSearchPath, type Org } from '../components/orgSearchModel';

/** Organisation codes are lowercase letters, digits and hyphens. */
const ORG_CODE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function Login() {
  const { register, user } = useAuth();
  const nav = useNavigate();
  const [orgCode, setOrgCode] = useState('');
  const [showCodeEntry, setShowCodeEntry] = useState(false);
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

  const chooseOrg = (org: Org) => {
    setErr('');
    nav(orgSearchPath(org));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await register({ email, password, name, tenantName });
      nav('/');
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : 'Could not create that organisation.');
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
          <BrandLogo variant="lockup" size={34} className="auth-logo" />
          <div className="brand-line" aria-hidden="true" />
          <h1 className="landing-title">Sign in</h1>
          <p className="muted small">Use the sign-in link your organisation shared, or find it by name.</p>

          {err && <Banner kind="error">{err}</Banner>}

          <OrgPicker onChoose={chooseOrg} />
          <div className="small muted" style={{ marginTop: 10, textAlign: 'center' }}>
            <button type="button" className="link-button" onClick={() => setShowCodeEntry(true)}>
              Enter an organisation code instead
            </button>
          </div>

          {showCodeEntry && (
            <form onSubmit={goToOrg} style={{ marginTop: 14 }}>
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
          )}

          <div className="landing-divider"><span>or</span></div>

          {/* There is deliberately no email-and-password form here any more.
              Sign-in starts with the organisation, and it has to: an address
              alone says nothing about which organisation the person means, and
              signing them into whichever one happens to hold that address is
              the kind of guess that is right until the day somebody works for
              two customers. Everyone arrives through /o/<slug>. */}
          <div className="small muted" style={{ textAlign: 'center' }}>
            No account yet? <Link to="/signup">Ask for one</Link>
            <br />
            {/* The onboarding lane owns what is behind this; the front door
                owns getting people to it. */}
            <Link to="/onboard">Bring your organisation to Questor</Link>
            <br />
            <Link to="/demo">Ask for a demo</Link>
          </div>

          {/* Self-registration is closed in production, so offering it there
              would only lead to an error. It is the one path that does not need
              an organisation, because it is the path that creates one. */}
          {import.meta.env.DEV && (
            <div className="small muted" style={{ marginTop: 14, textAlign: 'center' }}>
              {mode === 'register' ? (
                <form onSubmit={submit} style={{ textAlign: 'left' }}>
                  <label htmlFor="reg-name">Your name</label>
                  <input id="reg-name" value={name} onChange={(e) => setName(e.target.value)} required />
                  <label htmlFor="reg-org">Organisation name</label>
                  <input id="reg-org" value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="Acme Corp" />
                  <label htmlFor="email">Email</label>
                  <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
                  <label htmlFor="password">Password</label>
                  <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
                  <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
                    {busy ? 'Please wait…' : 'Create organisation'}
                  </button>
                  <div style={{ marginTop: 10, textAlign: 'center' }}>
                    <button type="button" className="link-button" onClick={() => setMode('login')}>Back</button>
                  </div>
                </form>
              ) : (
                <button type="button" className="link-button" onClick={() => setMode('register')}>Set up a new organisation</button>
              )}
              <div style={{ marginTop: 6 }}>Dev seed: <code>demo@questor.local</code> (run <code>npm run db:seed</code>)</div>
            </div>
          )}

        </div>
      </section>
      <ComplianceFooter />
    </div>
  );
}
