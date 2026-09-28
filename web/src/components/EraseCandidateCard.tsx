import { useId, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { eraseOthersLabel, eraseOutcome, eraseRequestBody, type EraseOutcome, type EraseResponse } from './candidateEraseModel';

/**
 * Right to erasure, for an admin: permanently removes this application, and
 * when asked the person's other applications too. A reason is required; the
 * audit trail records that erasure happened, not the reason text.
 */
export function EraseCandidateCard(props: {
  readonly candidateId: string;
  readonly fullName: string;
  /** Other applications for the same address; absent when the server did not say. */
  readonly otherApplications?: number;
  /** Called once this application is gone, with what to tell the admin. */
  readonly onErased: (text: string) => void;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [alsoOthers, setAlsoOthers] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<EraseOutcome | null>(null);
  const others = props.otherApplications ?? 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !reason.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await api.del<EraseResponse>(`/candidates/${props.candidateId}`, eraseRequestBody(reason, alsoOthers && others > 0));
      const result = eraseOutcome(res);
      if (result.gone) { props.onErased(result.text); return; }
      setOutcome(result);
      setSubmitting(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not erase this candidate.');
      setSubmitting(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title"><Icon name="user-x" />Erase candidate</h2>
      {error && <Banner kind="error">{error}</Banner>}
      {outcome && <Banner kind="info">{outcome.text}</Banner>}
      {!open ? (
        <>
          <p className="muted small">Permanently removes {props.fullName}&rsquo;s details, resume and interviews. This cannot be undone.</p>
          <button type="button" className="btn secondary" onClick={() => setOpen(true)}>Erase…</button>
        </>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor={`${fieldId}-reason`}>Reason</label>
          <textarea id={`${fieldId}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} required />
          <div className="muted small">Kept only as &ldquo;a reason was given&rdquo;; the text itself is not stored.</div>
          {others > 0 && (
            <label className="check-row" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={alsoOthers} onChange={(e) => setAlsoOthers(e.target.checked)} />
              {eraseOthersLabel(others)}
            </label>
          )}
          <p className="muted small">Anything under legal hold is kept.</p>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn danger" type="submit" disabled={submitting || !reason.trim()}>
              <Icon name={submitting ? 'hourglass' : 'user-x'} size={16} />
              {submitting ? 'Erasing…' : 'Erase permanently'}
            </button>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)} disabled={submitting}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
