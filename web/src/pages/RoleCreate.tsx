import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { canLoadSample, sampleDraft } from '../components/roleCreateModel';

interface CreateResp {
  role: { id: string; title: string; level: string; location: string; employmentType: string; status: string };
  scorecard: { id: string; version: number; status: string; profile: unknown };
  jdWarnings: { term: string; suggestion: string }[];
}

export function RoleCreate() {
  const nav = useNavigate();
  const [sourceText, setSourceText] = useState('');
  const [title, setTitle] = useState('');
  const [useLlm, setUseLlm] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<{ term: string; suggestion: string }[]>([]);

  // The sample is a demonstration. It loads only into an empty form, and it
  // fills the title as well as the description, because loading one without
  // the other produced a role named for one job with a scorecard for another.
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
      const resp = await api.post<CreateResp>('/roles', {
        sourceType: 'paste',
        sourceText,
        title: title || undefined,
        useLlm,
      });
      if (resp.jdWarnings && resp.jdWarnings.length) {
        setWarnings(resp.jdWarnings);
        // brief pause so the user sees the warnings, then navigate
        setTimeout(() => nav(`/roles/${resp.role.id}`), 1200);
      } else {
        nav(`/roles/${resp.role.id}`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'The role could not be created.');
      setSubmitting(false);
    }
  };

  return (
    <div>
      <PageHeader icon="role" title="New Role" subtitle="Paste a job description and Questor drafts a scorecard for you to review." />

      {error && <Banner kind="error">{error}</Banner>}
      {warnings.length > 0 && (
        <Banner kind="info">
          <div>Job description warnings (fixing before you interview improves fairness):</div>
          <ul style={{ margin: '6px 0 0' }}>
            {warnings.map((w, i) => (
              <li key={i} className="small"><b>{w.term}</b> — {w.suggestion}</li>
            ))}
          </ul>
        </Banner>
      )}

      <form className="card" onSubmit={submit}>
        <label htmlFor="role-title">Role title (optional — inferred from the JD if left blank)</label>
        <input id="role-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior Data Engineer" />

        <label htmlFor="role-jd">Job description</label>
        <textarea
          id="role-jd"
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="Paste the full job description here…"
          style={{ minHeight: 220 }}
          required
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={useLlm}
            onChange={(e) => setUseLlm(e.target.checked)}
            style={{ width: 'auto' }}
          />
          Use AI extraction (falls back to built-in extractor)
        </label>

        <div className="row" style={{ marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" type="submit" disabled={submitting || !sourceText.trim()}>
            <Icon name={submitting ? 'hourglass' : 'sparkle'} size={16} />
            {submitting ? 'Creating…' : 'Create role'}
          </button>
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
          {!sampleAllowed && (
            <span id="sample-jd-hint" className="muted small">
              The sample only loads into an empty form, so it never replaces what you have written.
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
