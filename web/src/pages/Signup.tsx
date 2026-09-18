import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { LandingHero } from '../components/LandingHero';
import { BrandLogo } from '../components/BrandLogo';
import { OrgPicker } from '../components/OrgPicker';
import { type Org } from '../components/orgSearchModel';
import {
  PASSWORD_MIN_LENGTH,
  signupFormProblem,
  signupRequestBody,
  type SignupForm,
  type SignupMode,
} from '../components/signupModel';

/**
 * Asking for an account.
 *
 * Nothing on this page creates anything. It files a request that a person reads
 * and decides, which is why the confirmation below is worded as carefully as it
 * is: it must not say an account was made, and it must read the same whether
 * the address was already known or not. The server answers every request
 * identically for that reason, and a page that contradicted it — by relaying a
 * "that address is taken" error, say — would hand back the very fact the
 * identical answer exists to withhold.
 */
export function Signup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<SignupMode>('new-org');
  const [organisationName, setOrganisationName] = useState('');
  const [orgCode, setOrgCode] = useState('');
  const [chosenOrg, setChosenOrg] = useState<Org | null>(null);
  const [showCodeEntry, setShowCodeEntry] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const form: SignupForm = { name, email, password, mode, organisationName, orgCode };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = signupFormProblem(form);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    setBusy(true);
    try {
      await api.post('/signup', signupRequestBody(form));
      setSent(true);
    } catch (err: unknown) {
      // Deliberately not the server's message. The endpoint says the same thing
      // to everyone on purpose; passing its text through is how that guarantee
      // would quietly stop being true. Being asked to slow down is the one
      // refusal that tells the sender nothing about anyone else.
      setError(err instanceof ApiError && err.status === 429
        ? 'That is a lot of requests in a short time. Please try again in a few minutes.'
        : 'We could not send your request just now. Please try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const chooseMode = (next: SignupMode) => {
    setMode(next);
    // The error on screen was about the mode being left behind.
    setError('');
  };

  const chooseOrg = (org: Org) => {
    setChosenOrg(org);
    setOrgCode(org.slug);
    setShowCodeEntry(false);
    setError('');
  };

  const changeOrg = () => {
    setChosenOrg(null);
    setOrgCode('');
    setShowCodeEntry(false);
  };

  const modeClass = (value: SignupMode) => (mode === value ? 'signup-mode is-chosen' : 'signup-mode');

  return (
    <div className="landing">
      {/* Decorative wash behind both columns; announced to nobody. */}
      <div className="landing-backdrop" aria-hidden="true" />
      <LandingHero />

      <section className="landing-panel">
        <div className="card auth-card">
          <BrandLogo variant="lockup" size={34} className="auth-logo" />
          <div className="brand-line" aria-hidden="true" />

          {sent ? (
            <>
              <h1 className="landing-title">Your request has been sent</h1>
              <p className="muted small">
                Someone will read it and decide. Nothing has been created yet — there is no account and no
                organisation until a person approves this request.
              </p>
              <p className="muted small">Any reply will come by email, to the address you gave.</p>
              <Link className="btn secondary" style={{ width: '100%', marginTop: 14 }} to="/login">
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="landing-title">Request an account</h1>
              <p className="muted small">
                Questor accounts are opened by a person, not automatically. Tell us who you are and what you
                need, and we will pass it on.
              </p>

              {error && <Banner kind="error">{error}</Banner>}

              <form onSubmit={submit} noValidate>
                <label htmlFor="signup-name">Your name</label>
                <input
                  id="signup-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />

                <label htmlFor="signup-email">Email</label>
                <input
                  id="signup-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />

                <label htmlFor="signup-password">Password</label>
                {/* Before the field, not after a rejection: a rule someone only
                    meets on the second attempt was not a rule, it was a trap. */}
                <p className="field-hint" id="signup-password-hint">
                  At least {PASSWORD_MIN_LENGTH} characters. Length is worth more here than punctuation.
                </p>
                <input
                  id="signup-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  aria-describedby="signup-password-hint"
                  minLength={PASSWORD_MIN_LENGTH}
                />

                <fieldset className="signup-modes">
                  <legend>What are you asking for?</legend>

                  <label className={modeClass('new-org')}>
                    <input
                      type="radio"
                      name="signup-mode"
                      value="new-org"
                      checked={mode === 'new-org'}
                      onChange={() => chooseMode('new-org')}
                    />
                    <span className="signup-mode-title">Start a new organisation</span>
                    <span className="signup-mode-detail">You would be its first user.</span>
                  </label>

                  <label className={modeClass('join')}>
                    <input
                      type="radio"
                      name="signup-mode"
                      value="join"
                      checked={mode === 'join'}
                      onChange={() => chooseMode('join')}
                    />
                    <span className="signup-mode-title">Join an organisation</span>
                    <span className="signup-mode-detail">Someone there already uses Questor.</span>
                  </label>
                </fieldset>

                {mode === 'new-org' ? (
                  <>
                    <label htmlFor="signup-org-name">Organisation name</label>
                    <input
                      id="signup-org-name"
                      value={organisationName}
                      onChange={(e) => setOrganisationName(e.target.value)}
                      placeholder="Acme Corp"
                      autoComplete="organization"
                    />
                  </>
                ) : (
                  <>
                    {chosenOrg ? (
                      <div className="chosen-org">
                        <div>
                          <span className="field-hint">Your organisation</span>
                          <strong>{chosenOrg.name}</strong>
                        </div>
                        <button type="button" className="link-button" onClick={changeOrg}>Change</button>
                      </div>
                    ) : (
                      <>
                        <OrgPicker onChoose={chooseOrg} />
                        <div className="small muted" style={{ marginTop: 10, textAlign: 'center' }}>
                          <button type="button" className="link-button" onClick={() => setShowCodeEntry(true)}>
                            Enter an organisation code instead
                          </button>
                        </div>
                      </>
                    )}

                    {showCodeEntry && (
                      <>
                        <label htmlFor="signup-org-code">Organisation code</label>
                        <p className="field-hint" id="signup-org-code-hint">
                          The code your colleagues sign in with. Ask whoever pointed you here.
                        </p>
                        <input
                          id="signup-org-code"
                          value={orgCode}
                          onChange={(e) => {
                            setChosenOrg(null);
                            setOrgCode(e.target.value);
                          }}
                          placeholder="acme-hiring"
                          autoCapitalize="none"
                          autoComplete="organization"
                          aria-describedby="signup-org-code-hint"
                        />
                      </>
                    )}
                  </>
                )}

                <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
                  {busy ? 'Sending…' : 'Send request'}
                </button>
              </form>

              <div className="small muted" style={{ marginTop: 14, textAlign: 'center' }}>
                Already have an account? <Link to="/login">Sign in</Link>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
