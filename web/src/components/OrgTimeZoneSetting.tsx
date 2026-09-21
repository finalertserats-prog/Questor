import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { listTimeZones, timeZoneOptionLabel } from './zonedScheduleModel';
import { orgTimeZoneField, orgTimeZonePatch, type OrgTimeZoneField } from './orgTimeZoneModel';

/**
 * The zone the organisation works in: the scheduling picker starts on it, and
 * a time booked without a zone is written in it. IST until an admin chooses.
 * Saved through the policy, which the server merges and audits.
 */
export function OrgTimeZoneSetting() {
  const zones = useMemo(() => {
    const now = new Date();
    return listTimeZones().map((zone) => ({ zone, offset: timeZoneOptionLabel(zone, now) }));
  }, []);
  const [field, setField] = useState<OrgTimeZoneField | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ policy: Record<string, unknown> }>('/admin/policy')
      .then((d) => {
        if (cancelled) return;
        const current = orgTimeZoneField(d.policy ?? {});
        setField(current);
        setDraft(current.zone);
      })
      .catch((err: unknown) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not read the setting.'); });
    return () => { cancelled = true; };
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const patch = orgTimeZonePatch(draft);
    if (!patch) {
      setNotice({ ok: false, text: 'Pick a time zone from the list, such as Asia/Kolkata.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api.put<{ policy: Record<string, unknown> }>('/admin/policy', patch);
      const current = orgTimeZoneField(saved.policy ?? {});
      setField(current);
      setDraft(current.zone);
      setNotice({ ok: true, text: `Saved. New times are shown in ${current.zone}.` });
    } catch (err: unknown) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'The setting could not be saved.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" data-testid="org-time-zone-setting">
      <h2>Time zone</h2>
      <p className="muted small">
        The scheduling picker starts on this zone, and a time booked without a zone is shown in it. A time booked in its own zone keeps that zone.
      </p>
      {/* Unread, the current zone is unknown: showing IST would invite an
          admin to "restore" a zone that was never changed. */}
      {loadError && <Banner kind="error">This setting could not be read. {loadError}</Banner>}
      {field && (
        <form onSubmit={save}>
          <p className="small">
            Now: <strong>{field.zone}</strong>{' '}
            <span className="muted">{field.chosen ? 'chosen for your organisation' : '(default)'}</span>
          </p>
          <label htmlFor="org-time-zone">Time zone</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="org-time-zone"
              list="org-time-zone-list"
              value={draft}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="Type a city, e.g. Kolkata"
              onChange={(e) => { setDraft(e.target.value); setNotice(null); }}
              required
            />
            <datalist id="org-time-zone-list">
              {zones.map(({ zone, offset }) => <option key={zone} value={zone} label={offset} />)}
            </datalist>
            <button className="btn sm" disabled={saving || (field.chosen && draft.trim() === field.zone)}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {notice && <Banner kind={notice.ok ? 'ok' : 'error'}>{notice.text}</Banner>}
        </form>
      )}
    </div>
  );
}
