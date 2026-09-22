import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Banner } from '../ui';
import { comparisonRows, trialStanding, type TrialReport } from './trialReportModel';

/**
 * The interleaved trial, side by side: library blocks against built-in blocks
 * of the same interviews. Loads on its own so a slow report never holds up
 * the rest of the owner's screen.
 */
export function TrialReportPanel() {
  const [report, setReport] = useState<TrialReport | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get<{ report: TrialReport }>('/library/admin/trial-report')
      .then((d) => { if (!cancelled) setReport(d.report); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'The trial report could not be loaded.'); });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="card" aria-labelledby="library-trial-heading" data-testid="library-trial-report">
      <h2 id="library-trial-heading" className="library-section-title">Interleaved trial</h2>
      {error && <Banner kind="error">{error}</Banner>}
      {report && (
        <>
          <p className="muted small">{trialStanding(report)}</p>
          {report.interviews > 0 && (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Library against built-in blocks">
              <table>
                <thead><tr><th>Measure</th><th>Library blocks</th><th>Built-in blocks</th></tr></thead>
                <tbody>
                  {comparisonRows(report).map((r) => (
                    <tr key={r.label}><td>{r.label}</td><td>{r.library}</td><td>{r.builtin}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
