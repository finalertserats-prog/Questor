import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { formatDateTime } from './dateFormat';
import {
  STATUS_BADGE, STATUS_WORD, emptySectionText, healthyToggleLabel, overallHeadline, splitChecks,
  type HealthCheckView, type HealthReportView, type HealthSectionView,
} from './systemHealthModel';

/**
 * "Is Questor healthy?" at the top of the Admin page.
 *
 * The owner's first question every morning used to need an SSH session and
 * four commands (see docs/RUNBOOK.md, Daily checks). This answers what the app
 * can know: everything green, anything amber to watch, anything red to fix —
 * each with what it means and what to do about it.
 *
 * It refreshes itself every minute while the tab is in front, and stops while
 * it is not: a forgotten tab polling a report that runs database queries is a
 * cost nobody chose.
 */

const REFRESH_MS = 60_000;

function CheckRow({ check }: { check: HealthCheckView }) {
  return (
    <li className="health-row" data-status={check.status}>
      <span className={`badge ${STATUS_BADGE[check.status]} health-word`}>{STATUS_WORD[check.status]}</span>
      <div className="health-text">
        <span className="health-label">{check.label}</span>
        <p className="health-summary">{check.summary}</p>
        {check.detail && <p className="health-detail">{check.detail}</p>}
        {check.action && <p className="health-action">{check.action}</p>}
      </div>
    </li>
  );
}

/** Exported for the render test, which pins problems above healthy checks. */
export function SystemHealthSection({ section }: { section: HealthSectionView }) {
  const { shown, healthy } = splitChecks(section.checks);
  return (
    <section className="health-section">
      <h3>{section.title}</h3>
      {shown.length === 0 && healthy.length === 0 && <p className="muted small">{emptySectionText()}</p>}
      {shown.length > 0 && <ul className="health-list">{shown.map((c) => <CheckRow key={c.id} check={c} />)}</ul>}
      {healthy.length > 0 && (
        // <details> rather than a state toggle: the browser gives it a name, a
        // keyboard and an expanded state for free, and it renders closed on the
        // server too.
        <details className="health-healthy">
          <summary>{healthyToggleLabel(healthy.length)}</summary>
          <ul className="health-list">{healthy.map((c) => <CheckRow key={c.id} check={c} />)}</ul>
        </details>
      )}
    </section>
  );
}

export function SystemHealthPanel() {
  const [report, setReport] = useState<HealthReportView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // Kept in a ref so the timer never closes over a stale controller.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    try {
      const next = await api.get<HealthReportView>('/admin/health', { signal: controller.signal });
      if (controller.signal.aborted) return;
      setReport(next);
      setError('');
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'System health could not be checked.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const tick = () => { if (!document.hidden) void load(); };
    const timer = setInterval(tick, REFRESH_MS);
    // Coming back to a tab that has been away for an hour: answer now, not in
    // 59 seconds.
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      inFlight.current?.abort();
    };
  }, [load]);

  const headline = error ? 'System health could not be checked' : overallHeadline(report);

  return (
    <section className="card health" aria-labelledby="system-health-title">
      <div className="health-head">
        <div className="health-headline">
          <h2 id="system-health-title">System health</h2>
          {/* One live region, holding the sentence that matters: a screen
              reader hears the verdict change, not every row under it. */}
          <p className="health-overall" data-status={error ? 'fail' : report?.status ?? 'info'} aria-live="polite">
            <span className={`badge ${error ? 'red' : STATUS_BADGE[report?.status ?? 'info']}`}>
              {error ? STATUS_WORD.fail : STATUS_WORD[report?.status ?? 'info']}
            </span>
            <span className="health-overall-text">{headline}</span>
          </p>
        </div>
        <div className="health-meta">
          {report && (
            <p className="health-checked">
              <span className="field-label">Checked</span>
              {formatDateTime(report.checkedAt)}
            </p>
          )}
          <button type="button" className="btn secondary sm" onClick={() => void load()} disabled={loading}>
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="health-error">{error} The rest of this page is unaffected.</p>}
      {!report && !error && <p className="muted small">Checking every part of Questor…</p>}
      {report?.sections.map((section) => <SystemHealthSection key={section.id} section={section} />)}
      {report?.scope === 'tenant' && (
        <p className="muted small health-scope">
          These checks cover your organisation. Checks about the whole deployment — backups, disk, background jobs — are shown to its operator.
        </p>
      )}
    </section>
  );
}
