import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { BrandLogo } from '../components/BrandLogo';
import {
  DEFAULT_BUSINESS_AREA_LIMIT, EMPTY_ONBOARD_FORM, PASSWORD_MIN_LENGTH,
  businessAreaCountLabel, canAddBusinessArea, filterBusinessAreas, onboardErrorMessage,
  onboardFormProblem, onboardRequestBody, toggleBusinessArea,
  type OnboardForm, type OnboardOptions,
} from '../components/onboardModel';
import '../styles/onboard.css';

/**
 * Bringing an organisation to Questor.
 *
 * Nothing on this page creates anything. It files a request that the Questor
 * team reads and decides, which is why the confirmation is worded as carefully
 * as it is: it must not say an account was made, and it must read the same
 * whether that organisation is already here or not. The server answers every
 * request identically for that reason, and a page that contradicted it — by
 * relaying "that organisation already exists", say — would hand back the fact
 * the identical answer exists to withhold.
 *
 * The business areas asked for here are the shared role catalog's own domains.
 * Choosing them narrows what this organisation searches later; it is never a
 * claim that the rest of the catalog is hidden from them.
 */
export function Onboard() {
  const [form, setForm] = useState<OnboardForm>(EMPTY_ONBOARD_FORM);
  const [options, setOptions] = useState<OnboardOptions | null>(null);
  const [areaQuery, setAreaQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.get<OnboardOptions>('/signup/options')
      .then((data) => { if (!cancelled) setOptions(data); })
      .catch(() => { if (!cancelled) setError('We could not load the form just now. Please reload the page.'); });
    return () => { cancelled = true; };
  }, []);

  const limit = options?.businessAreaLimit ?? DEFAULT_BUSINESS_AREA_LIMIT;
  const areas = useMemo(
    () => filterBusinessAreas(options?.businessAreas ?? [], areaQuery),
    [options, areaQuery],
  );

  const set = <K extends keyof OnboardForm>(key: K, value: OnboardForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError('');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = onboardFormProblem(form, limit);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    setBusy(true);
    try {
      await api.post('/signup', onboardRequestBody(form));
      setSent(true);
    } catch (err: unknown) {
      setError(onboardErrorMessage(err instanceof ApiError ? err.status : undefined));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="public-shell">
      <header className="public-bar">
        <Link to="/login" className="public-brand"><BrandLogo variant="lockup" size={28} /></Link>
        <Link to="/login" className="btn sm secondary">Sign in</Link>
      </header>
      <main className="public-body onboard-body">
        {sent ? (
          <div className="card onboard-card">
            <h1>Your request has been sent</h1>
            <p className="muted">
              Nothing has been created yet. Someone at Questor reads every request and decides on it,
              and we will email {form.email.trim().toLowerCase()} either way.
            </p>
            <p className="muted small">
              If your organisation is already on Questor, an admin there can add you directly —
              that is usually faster than waiting on this.
            </p>
            <Link to="/login" className="btn secondary" style={{ marginTop: 12 }}>Back to sign in</Link>
          </div>
        ) : (
          <form className="card onboard-card" onSubmit={submit} noValidate>
            <h1>Bring your organisation to Questor</h1>
            <p className="muted small">
              Tell us who you are and what you hire for. A person at Questor reads this and decides;
              nothing is created until they do.
            </p>

            {error && <Banner kind="error">{error}</Banner>}

            <fieldset className="onboard-section">
              <legend>Your organisation</legend>

              <label htmlFor="onboard-org">Organisation name</label>
              <input
                id="onboard-org" value={form.organisationName} maxLength={200} autoComplete="organization"
                onChange={(e) => set('organisationName', e.target.value)}
              />

              <label htmlFor="onboard-region">Where you hire</label>
              <p className="field-hint" id="onboard-region-hint">
                The rules we apply to job descriptions and interviews follow this.
                Choose Global if you hire across several of them.
              </p>
              <select
                id="onboard-region" value={form.regionCode} aria-describedby="onboard-region-hint"
                onChange={(e) => set('regionCode', e.target.value)}
              >
                <option value="">Choose a region…</option>
                {(options?.regions ?? []).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
              </select>

              <label htmlFor="onboard-size">Roughly how many people work there</label>
              <select id="onboard-size" value={form.orgSize} onChange={(e) => set('orgSize', e.target.value)}>
                <option value="">Choose a size…</option>
                {(options?.sizes ?? []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </fieldset>

            <fieldset className="onboard-section">
              <legend>You</legend>

              <label htmlFor="onboard-name">Your name</label>
              <input
                id="onboard-name" value={form.name} maxLength={200} autoComplete="name"
                onChange={(e) => set('name', e.target.value)}
              />

              <label htmlFor="onboard-email">Work email</label>
              <p className="field-hint" id="onboard-email-hint">
                We reply here, and this becomes the first admin account if the request is approved.
              </p>
              <input
                id="onboard-email" type="email" value={form.email} maxLength={254} autoComplete="email"
                aria-describedby="onboard-email-hint" onChange={(e) => set('email', e.target.value)}
              />

              <label htmlFor="onboard-password">Choose a password</label>
              <p className="field-hint" id="onboard-password-hint">
                At least {PASSWORD_MIN_LENGTH} characters. You will use it to sign in once the account exists.
              </p>
              <input
                id="onboard-password" type="password" value={form.password} autoComplete="new-password"
                aria-describedby="onboard-password-hint" onChange={(e) => set('password', e.target.value)}
              />
            </fieldset>

            <fieldset className="onboard-section">
              <legend>What you hire for</legend>
              <p className="field-hint" id="onboard-areas-hint">
                Choose up to {limit}. Questor's role catalog is shared by every organisation on it —
                picking your areas narrows what you search by default, so finding a role takes
                seconds instead of scrolling past everything else. You can change these later,
                and you can always search the whole catalog.
              </p>

              <label htmlFor="onboard-area-search" className="visually-hidden">Search business areas</label>
              <input
                id="onboard-area-search" type="search" value={areaQuery} placeholder="Search business areas…"
                onChange={(e) => setAreaQuery(e.target.value)}
              />

              <p className="onboard-count" aria-live="polite">
                {businessAreaCountLabel(form.businessAreas, limit)}
              </p>

              <ul className="onboard-areas" aria-describedby="onboard-areas-hint">
                {areas.map((area) => {
                  const chosen = form.businessAreas.includes(area.slug);
                  const open = canAddBusinessArea(form.businessAreas, area.slug, limit);
                  return (
                    <li key={area.slug}>
                      <label className={`onboard-area${chosen ? ' is-chosen' : ''}${open ? '' : ' is-full'}`}>
                        <input
                          type="checkbox" checked={chosen} disabled={!open}
                          onChange={() => set('businessAreas', toggleBusinessArea(form.businessAreas, area.slug, limit))}
                        />
                        <span className="onboard-area-name">{area.name}</span>
                        {area.summary && <span className="onboard-area-detail">{area.summary}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
              {areas.length === 0 && (
                <p className="muted small">No business area matches that. Try a shorter word.</p>
              )}
            </fieldset>

            <button className="btn onboard-submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send request'}
            </button>
            <p className="muted small" style={{ marginTop: 10 }}>
              Already on Questor? <Link to="/login">Sign in</Link> instead, or ask an admin at your
              organisation to add you.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
