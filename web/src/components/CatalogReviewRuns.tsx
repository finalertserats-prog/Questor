import { StatusBadge } from './StatusBadge';
import { formatDateTime } from './dateFormat';
import { runErrorText, runStatusLine, runTotals, type CatalogRunView } from './catalogReviewModel';

/** The newest run, in one line under the page header. */
export function LatestRunLine({ run }: { readonly run: CatalogRunView | undefined }) {
  if (!run) return <p className="muted small">No refresh has run yet. The monthly run starts on its own, or use Run now.</p>;
  return (
    <div>
      <div className="catalog-run-latest small">
        <StatusBadge kind="refreshRun" value={run.status} />
        <span>Latest {run.trigger === 'manual' ? 'manual' : 'scheduled'} run, started {formatDateTime(run.startedAt)}</span>
        <span className="muted">{runStatusLine(run)}</span>
      </div>
      {run.status === 'failed' && run.error && <p className="small catalog-run-error">The next run resumes where this one stopped.</p>}
    </div>
  );
}

function errorsOf(run: CatalogRunView): string[] {
  return (['onet', 'esco', 'web'] as const).flatMap((source) => run.stats[source].errors.map((e) => `${source.toUpperCase()}: ${e}`));
}

/** The last runs, newest first, with what each found and what went wrong. */
export function RecentRuns({ runs }: { readonly runs: readonly CatalogRunView[] }) {
  return (
    <section className="card" aria-labelledby="catalog-recent-runs">
      <h2 id="catalog-recent-runs">Recent runs</h2>
      {runs.length === 0 ? <p className="muted small">No runs yet.</p> : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Recent runs">
          <table>
            <thead>
              <tr><th>Started</th><th>Status</th><th>Trigger</th><th>Read</th><th>Proposed</th><th>Skipped</th><th>Model calls</th><th>Problems</th></tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const totals = runTotals(run);
                const problems = [...(run.error ? [runErrorText(run.error)] : []), ...errorsOf(run)];
                return (
                  <tr key={run.id}>
                    <td className="small">{formatDateTime(run.startedAt)}</td>
                    <td><StatusBadge kind="refreshRun" value={run.status} /></td>
                    <td className="small">{run.trigger === 'manual' ? `Manual${run.triggeredBy ? ` (${run.triggeredBy})` : ''}` : 'Scheduled'}</td>
                    <td>{totals.fetched}</td>
                    <td>{totals.proposed}</td>
                    <td>{totals.skipped}</td>
                    <td className="small">{run.llmCalls} classify · {run.researchCalls} research</td>
                    <td className="small">
                      {problems.length === 0 ? <span className="muted">None</span> : (
                        <details>
                          <summary>{problems.length} {problems.length === 1 ? 'problem' : 'problems'}</summary>
                          <ul className="small">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
