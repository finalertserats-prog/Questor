import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../Toast';

/**
 * The HR-Box daily summary switch in Settings. The organisation turns the
 * summary on (DIGEST_ENABLED); each person can turn it off for themselves.
 * Saved as it is changed, confirmed with a toast, and put back if the save fails.
 */
export function DigestSetting({ initialOptOut }: { initialOptOut: boolean }) {
  const [optOut, setOptOut] = useState(initialOptOut);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  // The session's copy is from sign-in; a change made since (here, then
  // navigating away and back) is only on the server.
  useEffect(() => {
    let cancelled = false;
    api.get<{ user: { digestOptOut?: boolean } }>('/auth/me')
      .then((me) => { if (!cancelled && typeof me.user.digestOptOut === 'boolean') setOptOut(me.user.digestOptOut); })
      .catch(() => { /* the sign-in copy stands */ });
    return () => { cancelled = true; };
  }, []);

  const change = async (wantsSummary: boolean) => {
    const previous = optOut;
    setOptOut(!wantsSummary);
    setSaving(true);
    setError('');
    try {
      const res = await api.patch<{ digestOptOut: boolean }>('/auth/me/preferences', { digestOptOut: !wantsSummary });
      setOptOut(res.digestOptOut);
      toast.show(res.digestOptOut ? 'Daily summary turned off.' : 'Daily summary turned on.');
    } catch (err: unknown) {
      setOptOut(previous);
      setError(err instanceof Error ? err.message : 'Your choice could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-theme hb-digest-setting">
      <label className="hb-check">
        <input type="checkbox" checked={!optOut} disabled={saving} onChange={(e) => void change(e.target.checked)} data-testid="digest-toggle" />
        <span>
          <span className="hb-check-title">Email me a daily summary of what needs me</span>
          <span className="small muted">One email each morning when something is waiting on you; none when nothing is.</span>
        </span>
      </label>
      {error && <div className="small hb-inline-error" role="alert">{error}</div>}
    </div>
  );
}
