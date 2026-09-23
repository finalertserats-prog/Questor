import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { LandingHero } from '../components/LandingHero';
import { BrandLogo } from '../components/BrandLogo';
import { ComplianceFooter } from '../components/ComplianceFooter';
import { SignInForm } from '../components/SignInForm';

interface OrgSummary {
  name: string;
  slug: string;
}

/** An organisation's own sign-in page, reached through its link (/o/:slug). */
export function OrgLogin() {
  const { slug = '' } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [lookup, setLookup] = useState<'loading' | 'found' | 'missing' | 'unreachable'>('loading');

  useEffect(() => {
    if (user) nav('/');
  }, [user, nav]);

  // Through the shared client, so this page gets the same timeout, the same
  // error type and the same unreadable-body handling as everything else.
  // "Link not recognised" for an outage was the worst possible reading: it
  // tells someone their own organisation's link is wrong when the truth is
  // that nothing could be reached.
  const lookUpOrg = useCallback(() => {
    let active = true;
    setLookup('loading');
    api.get<{ org: OrgSummary }>(`/orgs/${encodeURIComponent(slug)}`)
      .then((data) => {
        if (!active) return;
        setOrg(data.org);
        setLookup('found');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLookup(error instanceof ApiError && error.status === 404 ? 'missing' : 'unreachable');
      });
    return () => { active = false; };
  }, [slug]);

  useEffect(lookUpOrg, [lookUpOrg]);


  return (
    <div className="landing">
      {/* Decorative wash behind both columns; announced to nobody. */}
      <div className="landing-backdrop" aria-hidden="true" />
      <LandingHero />

      <section className="landing-panel">
        <div className="card auth-card">
          <BrandLogo variant="lockup" size={34} className="auth-logo" />
          <div className="brand-line" aria-hidden="true" />

          {lookup === 'loading' && <p className="muted small">Finding your organisation…</p>}

          {lookup === 'missing' && (
            <>
              <h1 className="landing-title">Link not recognised</h1>
              <p className="muted small">Check the link your organisation shared, or ask your Questor administrator for it.</p>
              <Link className="btn secondary" style={{ width: '100%', marginTop: 14 }} to="/login">Back to sign in</Link>
            </>
          )}

          {lookup === 'unreachable' && (
            <>
              <h1 className="landing-title">We can't reach Questor right now</h1>
              <p className="muted small">
                Your link looks fine — we simply could not load your organisation. This is usually
                brief.
              </p>
              <button type="button" className="btn" style={{ width: '100%', marginTop: 14 }} onClick={lookUpOrg}>
                Try again
              </button>
              <Link className="btn secondary" style={{ width: '100%', marginTop: 8 }} to="/login">Back to sign in</Link>
            </>
          )}

          {lookup === 'found' && org && (
            <>
              <SignInForm orgSlug={slug} orgName={org.name} />
              <div className="small muted" style={{ marginTop: 6, textAlign: 'center' }}>
                <Link to="/login">Not {org.name}?</Link>
              </div>
            </>
          )}
        </div>
      </section>
      <ComplianceFooter />
    </div>
  );
}
