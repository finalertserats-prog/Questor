import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { Banner } from '../components/ui';
import { LandingHero } from '../components/LandingHero';

interface OrgSummary {
  name: string;
  slug: string;
}

/** An organisation's own sign-in page, reached through its link (/o/:slug). */
export function OrgLogin() {
  const { slug = '' } = useParams();
  const { login, user } = useAuth();
  const nav = useNavigate();
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [lookup, setLookup] = useState<'loading' | 'found' | 'missing'>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) nav('/');
  }, [user, nav]);

  useEffect(() => {
    let active = true;
    setLookup('loading');
    fetch(`/api/orgs/${encodeURIComponent(slug)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ org: OrgSummary }>) : Promise.reject(new Error('not found'))))
      .then((data) => {
        if (!active) return;
        setOrg(data.org);
        setLookup('found');
      })
      .catch(() => {
        if (active) setLookup('missing');
      });
    return () => {
      active = false;
    };
  }, [slug]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(email, password, slug);
      nav('/');
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <LandingHero />

      <section className="landing-panel">
        <div className="card auth-card">
          <div className="logo" style={{ fontSize: 26 }}>QUES<span>TOR</span></div>
          <div className="brand-line" aria-hidden="true" />

          {lookup === 'loading' && <p className="muted small">Finding your organisation…</p>}

          {lookup === 'missing' && (
            <>
              <h1 className="landing-title">Link not recognised</h1>
              <p className="muted small">Check the link your organisation shared, or ask your Questor administrator for it.</p>
              <Link className="btn secondary" style={{ width: '100%', marginTop: 14 }} to="/login">Back to sign in</Link>
            </>
          )}

          {lookup === 'found' && org && (
            <>
              <p className="landing-eyebrow">Signing in to</p>
              <h1 className="landing-title">{org.name}</h1>
              {err && <Banner kind="error">{err}</Banner>}
              <form onSubmit={submit}>
                <label htmlFor="org-email">Email</label>
                <input id="org-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
                <label htmlFor="org-password">Password</label>
                <input id="org-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
                  {busy ? 'Please wait…' : 'Sign in'}
                </button>
              </form>
              <div className="small muted" style={{ marginTop: 12, textAlign: 'center' }}>
                <Link to="/login">Not {org.name}?</Link>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
