import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Banner } from './ui';
import {
  IDENTITY_PANEL_NOTE, OTHER_SIGNALS_NOTE,
  codeSummary, cvAnswerText, cvFollowUpsEmpty, type IdentityPanelData,
} from './identityPanelModel';

/**
 * The panel's content for given data: rendered directly in tests.
 *
 * Written to sit inside a fold on the assessment page, which supplies the
 * heading — hence no card and no title of its own.
 */
export function IdentityIntegrityView({ data }: { data: IdentityPanelData }) {
  const code = codeSummary(data.code);
  const empty = cvFollowUpsEmpty(data);
  return (
    <div data-testid="identity-integrity-panel">
      <p className="small muted">Level: {data.level.label}</p>

      <h3>One-time code</h3>
      <p><strong>{code.title}</strong></p>
      <p className="small">{code.detail}</p>

      <h3>Questions about the candidate's CV</h3>
      {empty && <p className="small">{empty}</p>}
      {data.cvFollowUps.items.length > 0 && (
        <ol className="small" style={{ paddingLeft: 18 }}>
          {data.cvFollowUps.items.map((item) => (
            <li key={item.question} style={{ marginBottom: 12 }}>
              <p style={{ margin: '0 0 4px' }}><span className="muted">From the CV: </span>{item.cvDetail}</p>
              <p style={{ margin: '0 0 4px' }}><span className="muted">Asked: </span>{item.question}</p>
              <blockquote style={{ margin: 0, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
                {cvAnswerText(item)}
              </blockquote>
            </li>
          ))}
        </ol>
      )}

      <h3>Other signals</h3>
      <p className="small">{OTHER_SIGNALS_NOTE}</p>

      <p className="small muted" style={{ marginTop: 12 }}>{IDENTITY_PANEL_NOTE}</p>
    </div>
  );
}

/** Loads the panel for one assessment. Hidden for anyone the server does not show it to. */
export function IdentityIntegrityPanel({ assessmentId }: { assessmentId: string }) {
  const [data, setData] = useState<IdentityPanelData | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get<IdentityPanelData>(`/assessments/${assessmentId}/identity`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) { setHidden(true); return; }
        setError(err instanceof Error ? err.message : 'Could not load identity checks.');
      });
    return () => { cancelled = true; };
  }, [assessmentId]);

  if (hidden) return null;
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) return <p className="muted">Loading the identity checks…</p>;
  return <IdentityIntegrityView data={data} />;
}
