import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Banner, Badge } from '../components/ui';
import { Icon } from '../components/Icon';

interface FeedbackRow {
  id: string;
  requestedBy: { name: string; email: string; company: string } | null;
  requestedAt: string | null;
  demoTakenAt: string;
  mode: string;
  modeLabel: string;
  stageLabel: string;
  endReasonLabel: string | null;
  minutesInInterview: number | null;
  source: string;
  body: string;
  injectionFlagged: boolean;
  injectionMatched: string[];
  purgesAt: string | null;
}

interface Payload {
  feedback: FeedbackRow[];
  spend: { dayKey: string; used: number; ceiling: number; perRun: number };
}

function day(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * What prospects said about the demo.
 *
 * THE TEXT IS RENDERED AS TEXT. React escapes it, there is no markdown pass,
 * no link detection and no summary: this is a stranger's free writing, it has
 * already been screened for injection on the way in, and the last thing it
 * should meet on the way out is anything that interprets it. A row whose text
 * tripped the screen is shown with the flag beside it and the words intact —
 * the owner is the right reader for an attempt to talk to a machine.
 */
export function DemoFeedbackAdmin() {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api.get<Payload>('/admin/demo-feedback')); setFailed(false); }
    catch { setFailed(true); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (failed) {
    return (
      <div>
        <PageHeader icon="notes" title="Demo feedback" />
        <Banner kind="error">Could not read the demo feedback. This page is for the platform owner only.</Banner>
      </div>
    );
  }

  if (!data) return <div className="card" role="status" aria-busy="true">Loading demo feedback…</div>;

  return (
    <div>
      <PageHeader icon="notes" title="Demo feedback" subtitle="What visitors said after trying the demo interview." />

      {/*
        Beside the feedback because the two are read together: a day the
        ceiling was reached is a day when everyone who arrived after it was
        offered the watched interview only, which changes what their feedback
        is feedback ABOUT.
      */}
      <div className="card demo-admin-spend">
        <span className="small muted">Model spend today ({data.spend.dayKey})</span>
        <strong>{data.spend.used} of {data.spend.ceiling}</strong>
        {data.spend.used >= data.spend.ceiling && (
          <Badge kind="amber">Ceiling reached — the candidate-side interview is not being offered today</Badge>
        )}
      </div>

      {data.feedback.length === 0 ? (
        <EmptyState
          icon="notes"
          title="No demo feedback yet"
          message="Feedback appears here when a visitor sends it, and is deleted with their sandbox after seven days."
        />
      ) : (
        <ul className="demo-admin-list">
          {data.feedback.map((row) => (
            <li key={row.id} className="card demo-admin-row">
              <header className="demo-admin-head">
                <div>
                  <strong>{row.requestedBy ? row.requestedBy.name : 'A visitor whose sandbox has been cleared'}</strong>
                  {row.requestedBy && (
                    <span className="small muted"> · {row.requestedBy.company} · {row.requestedBy.email}</span>
                  )}
                </div>
                <span className="small muted">{day(row.demoTakenAt)}</span>
              </header>

              <div className="demo-admin-facts small muted">
                <span><Icon name="eye" size={13} /> {row.modeLabel}</span>
                <span><Icon name="funnel" size={13} /> {row.stageLabel}</span>
                {row.endReasonLabel && <span><Icon name="clock" size={13} /> {row.endReasonLabel}</span>}
                {row.minutesInInterview !== null && <span>{row.minutesInInterview} min</span>}
                <span>{row.source === 'spoken' ? 'Dictated' : 'Typed'}</span>
                {row.requestedAt && <span>Asked for the demo {day(row.requestedAt)}</span>}
              </div>

              {row.injectionFlagged && (
                <p className="demo-admin-flag">
                  <Icon name="alert" size={14} />
                  This text matched the prompt-injection screen ({row.injectionMatched.length} pattern
                  {row.injectionMatched.length === 1 ? '' : 's'}). It is shown as written and has not been given to any model.
                </p>
              )}

              {/* Plain text. No markdown, no links, no interpretation. */}
              <p className="demo-admin-body">{row.body}</p>

              {row.purgesAt && (
                <p className="small muted">Deleted with this sandbox on {day(row.purgesAt)}.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
