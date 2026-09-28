import { Banner } from '../ui';
import { formatDateTime } from '../dateFormat';
import { budgetBurn, workerAdvice, workerStateLabel, workerStateTone, type LibraryOverview } from './libraryAdminModel';

/** Worker state, budget burn and the status counts, read at a glance. */
export function WorkerStatusPanel({ overview }: { overview: LibraryOverview }) {
  const burn = budgetBurn(overview.budget);
  const advice = workerAdvice(overview);
  const tone = workerStateTone(overview.worker.state);
  const counts = overview.counts;
  return (
    <section className="card library-status" aria-labelledby="library-status-heading" data-testid="library-worker-status">
      <h2 id="library-status-heading" className="library-section-title">Worker</h2>
      <div className="library-status-grid">
        <div className={`library-state is-${tone}`} data-testid="library-worker-state">
          <span className="library-state-label">{workerStateLabel(overview.worker.state)}</span>
          {overview.worker.reason && <span className="muted small">{overview.worker.reason}</span>}
        </div>
        <dl className="library-facts">
          <div><dt>Library</dt><dd>{overview.enabled ? 'on for organisations' : 'dark (LIBRARY_ENABLED=false)'}</dd></div>
          <div><dt>Worker switch</dt><dd>{overview.workerEnabled ? 'on' : 'off'}</dd></div>
          <div><dt>Critic</dt><dd>{overview.critic.provider} · {overview.critic.model} · {overview.critic.configured ? 'configured' : 'not configured'}</dd></div>
          <div><dt>Last batch</dt><dd>{overview.worker.lastBatchAt ? formatDateTime(overview.worker.lastBatchAt) : 'never'}</dd></div>
        </dl>
        <div className="library-budget" data-testid="library-budget">
          <div className="library-budget-row">
            <span>{burn.dailyLabel}</span>
            <div className="library-budget-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(burn.dailyShare * 100)} aria-label="Calls used today">
              <span style={{ width: `${Math.round(burn.dailyShare * 100)}%` }} />
            </div>
          </div>
          <div className="library-budget-row">
            <span>{burn.monthlyLabel}</span>
            <div className="library-budget-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(burn.monthlyShare * 100)} aria-label="Tokens used in the last 30 days">
              <span style={{ width: `${Math.round(burn.monthlyShare * 100)}%` }} />
            </div>
          </div>
        </div>
        <dl className="library-facts" data-testid="library-counts">
          <div><dt>Live</dt><dd>{counts.live ?? 0}</dd></div>
          <div><dt>Probational</dt><dd>{counts.probational ?? 0}</dd></div>
          <div><dt>In your queue</dt><dd>{overview.queueTotal}</dd></div>
          <div><dt>Rejected</dt><dd>{counts.rejected ?? 0}</dd></div>
          <div><dt>Retired</dt><dd>{counts.retired ?? 0}</dd></div>
        </dl>
      </div>
      {advice && <Banner kind={overview.worker.state === 'running' ? 'info' : 'error'}>{advice}</Banner>}
      {overview.worker.lastError && <p className="library-last-error small" data-testid="library-last-error">Last error: {overview.worker.lastError}</p>}
    </section>
  );
}
