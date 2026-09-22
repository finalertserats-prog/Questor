import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import {
  HIRING_POLICY_TOGGLES, hiringPolicySwitches, policyPatch, reviewWindowField, reviewWindowPatch,
  type HiringPolicyKey, type HiringPolicySwitches,
} from './hiringPolicyModel';
import { useToast } from './Toast';

/**
 * The organisation's switches for what happens once an interview is over:
 * the automatic feedback email to the candidate, and whether reviewers must
 * judge blind before the assessment opens. Each switch saves on its own,
 * because the server merges the patch into the stored policy.
 */
export function HiringPolicySettings() {
  const [switches, setSwitches] = useState<HiringPolicySwitches | null>(null);
  const [saving, setSaving] = useState<HiringPolicyKey | 'window' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const toast = useToast();
  const [loadError, setLoadError] = useState('');
  const [windowHours, setWindowHours] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get<{ policy: Record<string, unknown> }>('/admin/policy')
      .then((d) => {
        if (cancelled) return;
        setSwitches(hiringPolicySwitches(d.policy ?? {}));
        setWindowHours(String(reviewWindowField(d.policy ?? {}).hours));
      })
      .catch((err: unknown) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not read the settings.'); });
    return () => { cancelled = true; };
  }, []);

  const saveWindow = async (e: React.FormEvent) => {
    e.preventDefault();
    const patch = reviewWindowPatch(Number(windowHours));
    if (!patch) {
      setNotice({ ok: false, text: 'Give a whole number of hours between 0 and 168.' });
      return;
    }
    setSaving('window');
    setNotice(null);
    try {
      const saved = await api.put<{ policy: Record<string, unknown> }>('/admin/policy', patch);
      setWindowHours(String(reviewWindowField(saved.policy ?? {}).hours));
      toast.show('Saved.');
    } catch (err: unknown) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'The setting could not be saved.' });
    } finally {
      setSaving(null);
    }
  };

  const toggle = async (key: HiringPolicyKey, value: boolean) => {
    setSaving(key);
    setNotice(null);
    try {
      const saved = await api.put<{ policy: Record<string, unknown> }>('/admin/policy', policyPatch(key, value));
      setSwitches(hiringPolicySwitches(saved.policy ?? {}));
      toast.show('Saved.');
    } catch (err: unknown) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'The setting could not be saved.' });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="card" data-testid="hiring-policy-settings">
      <h2>After the interview</h2>
      {/* Unread, the switches' state is unknown: showing them would invite an
          admin to "restore" a setting that was never off. */}
      {loadError && <Banner kind="error">These settings could not be read. {loadError}</Banner>}
      {switches && HIRING_POLICY_TOGGLES.map((t) => (
        <div key={t.key} style={{ marginBottom: 14 }}>
          <label className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={switches[t.key]}
              disabled={saving !== null}
              onChange={(e) => void toggle(t.key, e.target.checked)}
              data-testid={`policy-${t.key}`}
            />
            <span>{t.label}</span>
          </label>
          <p className="muted small" style={{ margin: '4px 0 0' }}>{t.help}</p>
        </div>
      ))}
      {switches && (
        <form onSubmit={saveWindow} style={{ marginTop: 4 }}>
          <label htmlFor="feedback-review-window">Hours the team has to review before feedback is sent</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="feedback-review-window"
              type="number"
              min={0}
              max={168}
              step={1}
              value={windowHours}
              onChange={(e) => setWindowHours(e.target.value)}
              style={{ maxWidth: 120 }}
            />
            <button className="btn sm" disabled={saving !== null}>{saving === 'window' ? 'Saving…' : 'Save'}</button>
          </div>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            A completed review sends the candidate's feedback straight away. This is only the backstop, so nobody is
            left waiting on a review that never comes. 0 sends it as soon as the assessment is ready.
          </p>
        </form>
      )}
      {notice && !notice.ok && <Banner kind="error">{notice.text}</Banner>}
    </div>
  );
}
