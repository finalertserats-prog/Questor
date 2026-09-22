import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import {
  LIBRARY_MODE_OPTIONS, libraryModePatch, libraryNumbersPatch, librarySettingsOf,
  type LibraryMode, type LibrarySettingsView,
} from './questionLibraryModel';

/**
 * The organisation's switch for the question library, in Hiring policy. Shown
 * only while the deployment has the library on; with it off the server never
 * reads these settings, so offering them would promise something that cannot
 * happen.
 */
export function QuestionLibrarySettings() {
  const [available, setAvailable] = useState(false);
  const [settings, setSettings] = useState<LibrarySettingsView | null>(null);
  const [trialPercent, setTrialPercent] = useState('');
  const [windowDays, setWindowDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ enabled: boolean }>('/library/status')
      .then(async (status) => {
        if (cancelled || !status.enabled) return;
        const d = await api.get<{ policy: Record<string, unknown> }>('/admin/policy');
        if (cancelled) return;
        const view = librarySettingsOf(d.policy ?? {});
        setSettings(view);
        setTrialPercent(String(view.trialPercent));
        setWindowDays(String(view.windowDays));
        setAvailable(true);
      })
      // A deployment that cannot say whether the library is on shows nothing: off is the safe reading.
      .catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  if (!available || !settings) return null;

  const save = async (body: object) => {
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api.put<{ policy: Record<string, unknown> }>('/admin/policy', body);
      const view = librarySettingsOf(saved.policy ?? {});
      setSettings(view);
      setTrialPercent(String(view.trialPercent));
      setWindowDays(String(view.windowDays));
      setNotice({ ok: true, text: 'Saved.' });
    } catch (err: unknown) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'The setting could not be saved.' });
    } finally {
      setSaving(false);
    }
  };

  const saveNumbers = (e: React.FormEvent) => {
    e.preventDefault();
    const patch = libraryNumbersPatch(Number(trialPercent), Number(windowDays));
    if (!patch) {
      setNotice({ ok: false, text: 'Give a trial share between 0 and 100, and a window between 1 and 365 days.' });
      return;
    }
    void save(patch);
  };

  return (
    <div className="card" data-testid="question-library-settings">
      <h2>Question library</h2>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="muted small" style={{ marginBottom: 8 }}>Where interview questions come from</legend>
        {LIBRARY_MODE_OPTIONS.map((o) => (
          <div key={o.mode} style={{ marginBottom: 10 }}>
            <label className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input
                type="radio"
                name="question-library-mode"
                checked={settings.mode === o.mode}
                disabled={saving}
                onChange={() => void save(libraryModePatch(o.mode as LibraryMode))}
                data-testid={`library-mode-${o.mode}`}
              />
              <span>{o.label}</span>
            </label>
            <p className="muted small" style={{ margin: '4px 0 0 24px' }}>{o.help}</p>
          </div>
        ))}
      </fieldset>
      {settings.mode !== 'off' && (
        <form onSubmit={saveNumbers} style={{ marginTop: 4 }}>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            {settings.mode === 'trial' && (
              <div>
                <label htmlFor="library-trial-percent">Share of topics from the library in the trial (%)</label>
                <input id="library-trial-percent" type="number" min={0} max={100} step={1} value={trialPercent} onChange={(e) => setTrialPercent(e.target.value)} style={{ maxWidth: 120 }} />
              </div>
            )}
            <div>
              <label htmlFor="library-window-days">Days before a library question may be asked again for the same role</label>
              <input id="library-window-days" type="number" min={1} max={365} step={1} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} style={{ maxWidth: 120 }} />
            </div>
          </div>
          <button className="btn sm" disabled={saving} style={{ marginTop: 8 }}>{saving ? 'Saving…' : 'Save'}</button>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            A candidate is never asked the same library question twice, whatever the window.
          </p>
        </form>
      )}
      {notice && <Banner kind={notice.ok ? 'ok' : 'error'}>{notice.text}</Banner>}
    </div>
  );
}
