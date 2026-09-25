import { useState } from 'react';
import { EmptyState } from '../EmptyState';
import { gateLabel, humanSlug, verdictProblems, type EntryView } from './libraryAdminModel';

export type ReviewAction = 'approve' | 'reject' | 'edit' | 'retire';

interface Props {
  readonly entries: readonly EntryView[];
  readonly kind: 'queue' | 'sample';
  readonly busyIds: ReadonlySet<string>;
  readonly onDecide: (entry: EntryView, action: ReviewAction, payload: { readonly reason?: string; readonly questionText?: string }) => Promise<void>;
  readonly onOpen: (entry: EntryView) => void;
  readonly emptyTitle: string;
  readonly emptyMessage: string;
}

/**
 * The owner queue and the daily sample share one row: the question, its
 * anchors, why it is here, and the three decisions. State is marked with a
 * rule on the leading edge, never a tinted fill.
 */
export function EntryReviewList({ entries, kind, busyIds, onDecide, onOpen, emptyTitle, emptyMessage }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  if (entries.length === 0) return <EmptyState compact icon="list" title={emptyTitle} message={emptyMessage} />;

  const startEdit = (entry: EntryView) => { setEditingId(entry.id); setDraft(entry.questionText); setRejectingId(null); };
  const startReject = (entry: EntryView) => { setRejectingId(entry.id); setReason(''); setEditingId(null); };

  return (
    <ul className="library-entries" data-testid={`library-${kind}`}>
      {entries.map((entry) => {
        const busy = busyIds.has(entry.id);
        const problems = verdictProblems(entry.criticVerdict);
        const canApprove = entry.status === 'draft';
        return (
          <li key={entry.id} className="library-entry" data-testid={`library-${kind}-row`}>
            <div className="library-entry-head">
              <span className="library-entry-meta small muted">
                {humanSlug(entry.roleSlug)} · {humanSlug(entry.competencyKey)} · {entry.band} · {entry.form.replace('_', ' ')} · difficulty {entry.difficultyTag} · {entry.status}
              </span>
              <button type="button" className="btn ghost sm" onClick={() => onOpen(entry)} aria-label={`Open entry ${entry.id}`}>Details</button>
            </div>
            <p className="library-entry-question" data-testid="library-entry-question">{entry.questionText}</p>
            {entry.anchors.length > 0 && (
              <ul className="library-entry-anchors small">
                {entry.anchors.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            )}
            <p className="small muted">{gateLabel(entry)}{problems.length > 0 && entry.criticVerdict ? ` · critic: ${problems.join(', ')}` : ''}{entry.criticVerdict ? ` · confidence ${Math.round(entry.criticVerdict.confidence * 100)}%` : ''}</p>

            {editingId === entry.id ? (
              <form className="library-entry-editor" aria-label={`Edit entry ${entry.id}`} onSubmit={(e) => { e.preventDefault(); void onDecide(entry, 'edit', { questionText: draft }).then(() => setEditingId(null)); }}>
                <label className="visually-hidden" htmlFor={`edit-${entry.id}`}>Question</label>
                <textarea id={`edit-${entry.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} />
                <div className="library-entry-actions">
                  <button type="submit" className="btn sm" disabled={busy || draft.trim().length < 20}>Save as new draft</button>
                  <button type="button" className="btn ghost sm" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </form>
            ) : rejectingId === entry.id ? (
              <form className="library-entry-editor" aria-label={`Reject entry ${entry.id}`} onSubmit={(e) => { e.preventDefault(); void onDecide(entry, 'reject', { reason }).then(() => setRejectingId(null)); }}>
                <label className="visually-hidden" htmlFor={`reason-${entry.id}`}>Reason</label>
                <input id={`reason-${entry.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this should not be asked" />
                <div className="library-entry-actions">
                  <button type="submit" className="btn sm" disabled={busy || reason.trim().length === 0}>Confirm rejection</button>
                  <button type="button" className="btn ghost sm" onClick={() => setRejectingId(null)}>Cancel</button>
                </div>
              </form>
            ) : (
              <div className="library-entry-actions">
                {canApprove && <button type="button" className="btn sm" disabled={busy} onClick={() => void onDecide(entry, 'approve', {})} aria-label={`Approve entry ${entry.id}`}>Approve</button>}
                <button type="button" className="btn secondary sm" disabled={busy} onClick={() => startEdit(entry)} aria-label={`Edit entry ${entry.id}`}>Edit</button>
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => startReject(entry)} aria-label={`Reject entry ${entry.id}`}>Reject</button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
