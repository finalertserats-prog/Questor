import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import {
  HIRING_POLICY_TOGGLES, hiringPolicySwitches, policyPatch, type HiringPolicyKey, type HiringPolicySwitches,
} from './hiringPolicyModel';

/**
 * The organisation's switches for what happens once an interview is over:
 * the automatic feedback email to the candidate, and whether reviewers must
 * judge blind before the assessment opens. Each switch saves on its own,
 * because the server merges the patch into the stored policy.
 */
export function HiringPolicySettings() {
  const [switches, setSwitches] = useState<HiringPolicySwitches | null>(null);
  const [saving, setSaving] = useState<HiringPolicyKey | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get<{ policy: Record<string, unknown> }>('/admin/policy')
      .then((d) => { if (!cancelled) setSwitches(hiringPolicySwitches(d.policy ?? {})); })
      .catch((err: unknown) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not read the settings.'); });
    return () => { cancelled = true; };
  }, []);

  const toggle = async (key: HiringPolicyKey, value: boolean) => {
    setSaving(key);
    setNotice(null);
    try {
      const saved = await api.put<{ policy: Record<string, unknown> }>('/admin/policy', policyPatch(key, value));
      setSwitches(hiringPolicySwitches(saved.policy ?? {}));
      setNotice({ ok: true, text: 'Saved.' });
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
      {notice && <Banner kind={notice.ok ? 'ok' : 'error'}>{notice.text}</Banner>}
    </div>
  );
}
