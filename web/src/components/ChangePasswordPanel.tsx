import { useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { useToast } from './Toast';
import { newPasswordProblem, PASSWORD_HINT, PASSWORD_MIN_LENGTH } from './passwordModel';

/**
 * Change your own password, from Settings.
 *
 * The current password is asked for every time. Questor runs on shared office
 * machines, and without it whoever sits down at an unlocked session could lock
 * the owner out of their own account.
 */
export function ChangePasswordPanel() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current) { setProblem('Please enter your current password.'); return; }
    const bad = newPasswordProblem(next, confirmation);
    if (bad) { setProblem(bad); return; }
    if (current === next) { setProblem('Your new password must be different from your current one.'); return; }
    setProblem('');
    setBusy(true);
    try {
      await api.post('/auth/password/change', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setConfirmation('');
      // Done, with nothing left for the person to do — the rule this codebase
      // holds toasts to. What still needs acting on is a banner, above.
      toast.show('Password changed. You have been signed out everywhere else.', { testId: 'password-changed' });
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" data-testid="change-password-panel" aria-labelledby="change-password-title">
      <h2 id="change-password-title">Password</h2>
      <p className="muted small">
        Changing your password signs you out of every other browser you are signed in on. We email
        you whenever it changes, so an account someone else has reached does not stay quiet.
      </p>
      {problem && <Banner kind="error">{problem}</Banner>}
      <form onSubmit={submit} noValidate>
        <label htmlFor="current-password">Current password</label>
        <input
          id="current-password"
          name="current-password"
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
        <label htmlFor="new-password">New password</label>
        <p className="field-hint" id="new-password-hint">{PASSWORD_HINT}</p>
        <input
          id="new-password"
          name="new-password"
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          aria-describedby="new-password-hint"
          minLength={PASSWORD_MIN_LENGTH}
        />
        <label htmlFor="confirm-password">Repeat new password</label>
        <input
          id="confirm-password"
          name="confirm-password"
          type="password"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          autoComplete="new-password"
        />
        <div className="row" style={{ marginTop: 16, gap: 8 }}>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}
