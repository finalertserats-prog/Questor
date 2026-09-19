import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { isAtsId } from './atsModel';

interface LinkView { externalCandidateId: string; source: string; createdAt: string }
interface LinkResp { connected: boolean; link: LinkView | null }

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/**
 * Which ATS record this candidate is. Exports go only to this record, so
 * setting it is an admin action, and the server checks the id exists in the
 * organisation's own ATS before saving it.
 */
export function CandidateAtsLink({ candidateId }: { candidateId: string }) {
  const [data, setData] = useState<LinkResp | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<LinkResp>(`/candidates/${encodeURIComponent(candidateId)}/ats-link`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err: unknown) => { if (!cancelled) setLoadError(errorText(err, 'Could not load the ATS link.')); });
    return () => { cancelled = true; };
  }, [candidateId]);

  const trimmed = draft.trim();
  const valid = isAtsId(trimmed);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const d = await api.put<{ link: LinkView }>(`/candidates/${encodeURIComponent(candidateId)}/ats-link`, { externalCandidateId: trimmed });
      setData((prev) => ({ connected: prev?.connected ?? true, link: d.link }));
      setDraft('');
      setNotice({ kind: 'ok', text: 'Linked. Exports for this candidate now go to that ATS record.' });
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: errorText(err, 'Could not link this candidate.') });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || !window.confirm('Remove the ATS link? Assessments for this candidate cannot be exported until it is set again.')) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.del(`/candidates/${encodeURIComponent(candidateId)}/ats-link`);
      setData((prev) => ({ connected: prev?.connected ?? false, link: null }));
      setNotice({ kind: 'ok', text: 'Link removed.' });
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: errorText(err, 'Could not remove the link.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-testid="candidate-ats-link">
      <h2 className="card-title"><Icon name="role" />ATS record</h2>
      {loadError && <Banner kind="error">{loadError}</Banner>}
      {data && !data.connected && (
        <p className="muted small">
          Your organisation has not connected an ATS. <Link to="/settings">Connect one in Settings</Link> to link candidates.
        </p>
      )}
      {data?.link && (
        <p className="small">
          Linked to ATS candidate <code>{data.link.externalCandidateId}</code>
          {data.link.source === 'import' ? ' (imported from the ATS)' : ''}.
        </p>
      )}
      {data && !data.link && data.connected && <p className="muted small">Not linked yet. Assessments cannot be exported until it is.</p>}
      {notice && <div role="status" aria-live="polite"><Banner kind={notice.kind}>{notice.text}</Banner></div>}
      {data?.connected && (
        <form className="row" style={{ alignItems: 'flex-end', gap: 8 }} onSubmit={save}>
          <div style={{ flex: 1 }}>
            <label htmlFor="ats-candidate-id">{data.link ? 'Change to ATS candidate id' : 'ATS candidate id'}</label>
            <input
              id="ats-candidate-id"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setNotice(null); }}
              placeholder="e.g. 48213"
              pattern="[A-Za-z0-9_\-]{1,64}"
              title="Letters, numbers, dashes or underscores"
            />
          </div>
          <button className="btn" type="submit" disabled={!valid || busy}>{busy ? 'Checking…' : 'Link'}</button>
          {data.link && (
            <button className="btn secondary" type="button" onClick={() => { void remove(); }} disabled={busy}>Remove link</button>
          )}
        </form>
      )}
    </div>
  );
}
