import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Banner } from '../ui';
import { Skeleton } from '../Skeleton';
import { formatDateTime } from '../dateFormat';
import { humanSlug, stratumLabel, verdictProblems, type EntryView, type HistoryRow } from './libraryAdminModel';

interface Detail {
  readonly entry: EntryView;
  readonly history: readonly HistoryRow[];
  readonly standard: { readonly id: string; readonly version: number } | null;
  readonly supersededBy: { readonly id: string; readonly status: string } | null;
}

/** One entry in full: the critic's verdict, its provenance, and every decision taken on it. */
export function EntryDetail({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError('');
    api.get<Detail>(`/library/admin/entries/${entryId}`)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'The entry could not be loaded.'); });
    return () => { cancelled = true; };
  }, [entryId]);

  return (
    <section className="card library-detail" aria-labelledby="library-detail-heading" data-testid="library-entry-detail">
      <div className="library-entry-head">
        <h2 id="library-detail-heading" className="library-section-title">Entry</h2>
        <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {!detail && !error && <Skeleton lines={4} label="Loading entry…" />}
      {detail && (
        <>
          <p className="library-entry-question">{detail.entry.questionText}</p>
          <dl className="library-facts">
            <div><dt>Pool</dt><dd>{humanSlug(detail.entry.roleSlug)} · {humanSlug(detail.entry.competencyKey)} · {detail.entry.band}</dd></div>
            <div><dt>Form · difficulty</dt><dd>{detail.entry.form.replace('_', ' ')} · {detail.entry.difficultyTag}</dd></div>
            <div><dt>Status</dt><dd>{detail.entry.status}{detail.entry.gateReasons.length > 0 ? ` (${detail.entry.gateReasons.join(', ')})` : ''}</dd></div>
            <div><dt>Stratum</dt><dd>{stratumLabel(detail.entry.stratumKey)}</dd></div>
            <div><dt>Generator</dt><dd>{detail.entry.generatorModel || '—'} · {detail.entry.generatorPromptVersion}</dd></div>
            <div><dt>Critic</dt><dd>{detail.entry.criticModel || '—'}</dd></div>
            <div><dt>Standard</dt><dd>{detail.standard ? `v${detail.standard.version}` : 'none'}</dd></div>
            {detail.entry.supersedesId && <div><dt>Supersedes</dt><dd>{detail.entry.supersedesId}</dd></div>}
            {detail.supersededBy && <div><dt>Superseded by</dt><dd>{detail.supersededBy.id} ({detail.supersededBy.status})</dd></div>}
            {detail.entry.rationale && <div><dt>Why it fits</dt><dd>{detail.entry.rationale}</dd></div>}
          </dl>
          <h3 className="library-subtitle">Anchors</h3>
          <ul className="library-entry-anchors small">{detail.entry.anchors.map((a, i) => <li key={i}>{a}</li>)}</ul>
          <h3 className="library-subtitle">Critic verdict</h3>
          {detail.entry.criticVerdict ? (
            <p className="small" data-testid="library-critic-verdict">
              {verdictProblems(detail.entry.criticVerdict).length === 0 ? 'All checks passed' : verdictProblems(detail.entry.criticVerdict).join(', ')} · confidence {Math.round(detail.entry.criticVerdict.confidence * 100)}%
              {detail.entry.criticVerdict.notes ? ` · ${detail.entry.criticVerdict.notes}` : ''}
            </p>
          ) : <p className="small muted">No verdict recorded.</p>}
          <h3 className="library-subtitle">History</h3>
          <ol className="library-history small" data-testid="library-entry-history">
            {detail.history.map((h) => (
              <li key={h.id}>
                <span className="muted">{formatDateTime(h.at)}</span> · {h.actor} · {h.action}
                {h.fromStatus !== h.toStatus ? ` (${h.fromStatus || 'new'} → ${h.toStatus})` : ''}{h.reason ? ` — ${h.reason}` : ''}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
