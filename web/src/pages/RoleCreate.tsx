import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { atsErrorMessage, isAtsId } from '../components/atsModel';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { canLoadSample, sampleDraft } from '../components/roleCreateModel';

type Source = 'paste' | 'ats';

interface CreateResp {
  /** True when the requisition had been imported before; the role is that one. */
  alreadyImported?: boolean;
  role: { id: string; title: string; level: string; location: string; employmentType: string; status: string };
  scorecard: { id: string; version: number; status: string; profile: unknown };
  jdWarnings: { term: string; suggestion: string }[];
}


export function RoleCreate() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [source, setSource] = useState<Source>('paste');
  const [requisitionId, setRequisitionId] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [title, setTitle] = useState('');
  const [useLlm, setUseLlm] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<{ term: string; suggestion: string }[]>([]);
  // Set once the role exists: the warnings are shown against it, and the way on
  // is a button rather than a timer.
  const [createdRoleId, setCreatedRoleId] = useState<string | null>(null);

  // The sample loads only into an empty form, and fills the title as well as
  // the description: loading one without the other produced a role named for
  // one job with a scorecard for another.
  const sampleAllowed = canLoadSample({ sourceText, title });
  const loadSample = () => {
    if (!sampleAllowed) return;
    const draft = sampleDraft();
    setTitle(draft.title);
    setSourceText(draft.sourceText);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const resp = await api.post<CreateResp>('/roles', source === 'ats'
        ? { sourceType: 'ats', atsRequisitionId: requisitionId.trim(), title: title || undefined, useLlm }
        : { sourceType: 'paste', sourceText, title: title || undefined, useLlm });
      if (resp.jdWarnings && resp.jdWarnings.length) {
        // The warnings are about fairness in the wording someone is about to
        // interview against. 1200ms was never enough to read them, and the page
        // left of its own accord while they were still reading — so the role is
        // there when they are ready for it.
        setWarnings(resp.jdWarnings);
        setCreatedRoleId(resp.role.id);
        setSubmitting(false);
        return;
      }
      nav(`/roles/${resp.role.id}`);
    } catch (err: unknown) {
      // "No ATS connected" is a setup step, not a failure; say who can take it.
      if (err instanceof ApiError) setError(atsErrorMessage(err, user?.role === 'admin'));
      else setError(err instanceof Error ? err.message : 'Could not create this role.');
      setSubmitting(false);
    }
  };

  return (
    <div>
      <PageHeader icon="role" title="New Role" subtitle="Paste a job description, or import a requisition from your ATS, and Questor drafts a scorecard for you to review." />

      {error && <Banner kind="error">{error}</Banner>}
      {warnings.length > 0 && (
        <Banner kind="info">
          <div>Job description warnings (fixing before you interview improves fairness):</div>
          <ul style={{ margin: '6px 0 0' }}>
            {warnings.map((w, i) => (
              <li key={i} className="small"><b>{w.term}</b> — {w.suggestion}</li>
            ))}
          </ul>
          {createdRoleId && (
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className="btn" onClick={() => nav(`/roles/${createdRoleId}`)}>
                Continue to the role<Icon name="arrow-right" size={16} />
              </button>
            </div>
          )}
        </Banner>
      )}

      <form className="card" onSubmit={submit}>
        <fieldset className="row" style={{ border: 0, padding: 0, gap: 16 }}>
          <legend className="small muted">Start from</legend>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="radio" name="role-source" style={{ width: 'auto' }} checked={source === 'paste'} onChange={() => { setSource('paste'); setError(''); }} />
            A job description
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="radio" name="role-source" style={{ width: 'auto' }} checked={source === 'ats'} onChange={() => { setSource('ats'); setError(''); }} />
            A requisition in your ATS
          </label>
        </fieldset>

        <label>Role title (optional — inferred from the {source === 'ats' ? 'requisition' : 'JD'} if left blank)</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior Data Engineer" />

        {source === 'ats' ? (
          <>
            <label htmlFor="ats-requisition-id">ATS requisition id</label>
            <input
              id="ats-requisition-id"
              value={requisitionId}
              onChange={(e) => setRequisitionId(e.target.value)}
              placeholder="e.g. REQ-1042"
              pattern="[A-Za-z0-9_\-]{1,64}"
              title="Letters, numbers, dashes or underscores"
              required
            />
            <div className="muted small">Imported from your organisation's own ATS. Importing the same requisition again opens the role it already made.</div>
          </>
        ) : (
          <>
            <label>Job description</label>
            <textarea
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="Paste the full job description here…"
              style={{ minHeight: 220 }}
              required
            />
          </>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={useLlm}
            onChange={(e) => setUseLlm(e.target.checked)}
            style={{ width: 'auto' }}
          />
          Use AI extraction (falls back to built-in extractor)
        </label>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" type="submit" disabled={submitting || (source === 'ats' ? !isAtsId(requisitionId.trim()) : !sourceText.trim())}>
            <Icon name={submitting ? 'hourglass' : 'sparkle'} size={16} />
            {submitting ? (source === 'ats' ? 'Importing…' : 'Creating…') : (source === 'ats' ? 'Import role' : 'Create role')}
          </button>
          {/* Development only. A button that fills a real hiring form with a
              made-up job has no business in a console someone hires from. */}
          {import.meta.env.DEV && source === 'paste' && (
            <button
              className="btn secondary"
              type="button"
              onClick={loadSample}
              disabled={!sampleAllowed}
              aria-describedby="sample-jd-hint"
            >
              <Icon name="job" size={16} />
              Load sample JD
            </button>
          )}
          {import.meta.env.DEV && source === 'paste' && !sampleAllowed && (
            <span id="sample-jd-hint" className="muted small">
              The sample only loads into an empty form, so it never replaces what you have written.
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
