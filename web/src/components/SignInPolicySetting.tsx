import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { useToast } from './Toast';

type MfaPolicy = 'everyone' | 'admins' | 'off';

interface Settings {
  mfaPolicy: MfaPolicy;
  policies: MfaPolicy[];
  listed: boolean;
}

const CHOICES: ReadonlyArray<{ value: MfaPolicy; label: string; detail: string }> = [
  {
    value: 'everyone',
    label: 'Everyone',
    detail: 'Every person here enters a code from their email after their password. The strongest setting, and the one that asks the most of people who sign in many times a day.',
  },
  {
    value: 'admins',
    label: 'Administrators only',
    detail: 'The accounts that can add people, change roles, read the audit trail and export candidate data. Recommended: it protects what matters most and asks nothing of everybody else.',
  },
  {
    value: 'off',
    label: 'Nobody',
    detail: 'A password alone signs anyone in. This is where every organisation starts, so you can turn it on when you are ready rather than the day you arrive.',
  },
];

/**
 * Who in this organisation has to enter a sign-in code, and whether the
 * organisation can be found by name on the sign-in page.
 *
 * Both live here because both are answers to "how do our people get in", and
 * an admin looking for one will look for the other in the same place.
 */
export function SignInPolicySetting() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * `keepError` exists because the obvious shape — catch, set an error, then
   * re-read to get back in step — wipes the error it just set, since a
   * successful read clears it. On a security control that is the worst failure
   * available: the radio snaps back to what it was, nothing is said, and the
   * admin walks away believing the policy changed.
   */
  const load = useCallback(async (keepError = false) => {
    try {
      setSettings(await api.get<Settings>('/admin/signin-policy'));
      if (!keepError) setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load your sign-in settings.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<Pick<Settings, 'mfaPolicy' | 'listed'>>) => {
    setBusy(true);
    setError('');
    try {
      const saved = await api.put<Settings & { note?: string }>('/admin/signin-policy', patch);
      setSettings({ mfaPolicy: saved.mfaPolicy, policies: saved.policies, listed: saved.listed });
      toast.show(saved.note ?? 'Saved.', { testId: 'signin-policy-saved' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save that.');
      // Re-read so the controls show what the server actually holds, without
      // swallowing the sentence that says the save did not happen.
      await load(true);
    } finally {
      setBusy(false);
    }
  };

  if (!settings && !error) return null;

  return (
    <section className="card" data-testid="signin-policy" aria-labelledby="signin-policy-title">
      <h2 id="signin-policy-title">Signing in</h2>
      <p className="muted small">
        A password that leaks is the whole way in. A code emailed after it means a stolen password
        is not enough on its own.
      </p>
      {error && <Banner kind="error">{error}</Banner>}

      {settings && (
        <>
          {/* Shown only while it is off, and said as what will happen rather
              than as an exhortation. Someone switching a security control on
              needs to know what the next sign-in looks like — theirs included —
              and that it is one press to switch back. */}
          {settings.mfaPolicy === 'off' && (
            <div className="signin-off-note">
              <p>
                Sign-in codes are <strong>off</strong> for your organisation. Turning them on takes
                one press below and applies from the next sign-in: the person types their password,
                we email them six digits, and they type those in. Nobody is signed out, and nothing
                else changes.
              </p>
              <p className="muted small">
                Try it on your own account first. If a code does not arrive, set this back to
                Nobody and ask your Questor contact to check the email settings — a code that
                cannot be delivered is a door nobody can open.
              </p>
            </div>
          )}

          <fieldset className="policy-choices">
            <legend className="field-label">Who enters a code after their password</legend>
            {CHOICES.map((choice) => (
              <label
                key={choice.value}
                className={`policy-choice${settings.mfaPolicy === choice.value ? ' is-chosen' : ''}`}
                htmlFor={`mfa-${choice.value}`}
              >
                <input
                  id={`mfa-${choice.value}`}
                  type="radio"
                  name="mfa-policy"
                  value={choice.value}
                  checked={settings.mfaPolicy === choice.value}
                  disabled={busy}
                  onChange={() => void save({ mfaPolicy: choice.value })}
                />
                <span>
                  <span className="policy-choice-label">{choice.label}</span>
                  <span className="muted small">{choice.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {/* Said before it happens, not after: an admin tightening the policy
              is about to sign every remembered device out, and finding that out
              from a toast is finding it out too late. */}
          <p className="muted small" style={{ marginTop: 10 }}>
            Changing this asks everyone for a code again on devices they had chosen to be remembered
            on.
          </p>

          <label className="check-row" htmlFor="org-listed">
            <input
              id="org-listed"
              type="checkbox"
              checked={settings.listed}
              disabled={busy}
              onChange={(e) => void save({ listed: e.target.checked })}
            />
            <span>Let people find us by name on the sign-in page</span>
          </label>
          <p className="field-hint" id="org-listed-hint">
            With this off, your name never appears in the sign-in search. Your own link still works
            and your people sign in exactly as they do now.
          </p>
        </>
      )}
    </section>
  );
}
