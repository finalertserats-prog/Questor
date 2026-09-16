import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { Banner, stateBadge } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { WorkflowDiagram } from '../components/WorkflowDiagram';
import { HorizontalBarChart, WeeklyColumnChart, type BarItem, type WeekPoint } from '../components/DashboardCharts';
import { formatHours, groupSessionStates } from '../components/dashboardModel';
import { canReadAudit } from '../components/profileMenuModel';

interface Metrics {
  generatedAt: string;
  kpis: {
    openRoles: number;
    candidates: number;
    activePipelines: number;
    scheduledNext7Days: number;
    completedLast30Days: number;
    awaitingReview: number;
    avgInviteToCompleteHours: number | null;
    decisions: { APPROVED: number; REJECTED: number; WITHDRAWN: number };
  };
  interviewsPerWeek: WeekPoint[];
  pipelineStages: { key: string; label: string; count: number }[];
  stateCounts: Record<string, number>;
  recentInterviews: {
    id: string; state: string; createdAt: string; scheduledAt: string | null; completedAt: string | null;
    candidate: { id: string; name: string }; role: { id: string; title: string };
  }[];
}

const STATE_TONES: Record<string, string> = {
  scheduled: 'tone-accent-soft',
  live: 'tone-hold',
  review: 'tone-accent',
  reviewed: 'tone-pass',
  stopped: 'tone-stop',
  other: 'tone-muted',
};

function Kpi({ icon, label, value, hint, to }: { icon: IconName; label: string; value: ReactNode; hint?: ReactNode; to?: string }) {
  const body = (
    <>
      <span className="kpi-icon"><Icon name={icon} size={18} /></span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </>
  );
  return <li className="kpi">{to ? <Link to={to} className="kpi-link">{body}</Link> : <div className="kpi-link">{body}</div>}</li>;
}

/** The date that matters most for where an interview is in its life. */
function interviewDate(row: Metrics['recentInterviews'][number]): { label: string; at: string } {
  if (row.completedAt) return { label: 'Completed', at: row.completedAt };
  if (row.scheduledAt) return { label: 'Scheduled', at: row.scheduledAt };
  return { label: 'Created', at: row.createdAt };
}

export function Dashboard() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    api.get<Metrics>('/dashboard/metrics?weeks=12&recent=8')
      .then(setMetrics)
      .catch((err: unknown) => setError({
        status: err instanceof ApiError ? err.status : 0,
        message: err instanceof Error ? err.message : 'Could not load dashboard metrics.',
      }))
      .finally(() => setLoading(false));
  }, []);

  const k = metrics?.kpis;
  const stageItems: BarItem[] = (metrics?.pipelineStages ?? []).map((s) => ({ ...s, tone: 'tone-accent' }));
  const stateItems: BarItem[] = groupSessionStates(metrics?.stateCounts ?? {}).map((g) => ({ ...g, tone: STATE_TONES[g.key] }));
  const inPipeline = stageItems.reduce((sum, s) => sum + s.count, 0);
  const totalInterviews = stateItems.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="dashboard">
      <div className="topbar">
        <h1>Dashboard</h1>
        <div className="row">
          <Link className="btn" to="/roles/new">New Role</Link>
          <Link className="btn secondary" to="/candidates">Candidates</Link>
          <Link className="btn secondary" to="/candidates/new">Add Candidate</Link>
        </div>
      </div>

      {/* data-tour marks what the guided tour points at (components/tourModel.ts). */}
      <WorkflowDiagram anchor="workflow" />

      {error?.status === 403 ? (
        <Banner kind="info">
          Hiring metrics need access to candidate records, which your role does not include.
          {user && canReadAudit(user.role) && <> You can review activity in the <Link to="/audit">audit log</Link>.</>}
        </Banner>
      ) : error && <Banner kind="error">{error.message}</Banner>}

      {loading && <div className="muted">Loading metrics…</div>}

      {/* Counts are scoped to what this user may see, so an unassigned recruiter
          in a busy tenant would otherwise be told the product is empty. */}
      {k && k.openRoles === 0 && k.candidates === 0 && user?.role === 'admin' && (
        <Banner kind="info">
          Getting started: create your first <Link to="/roles/new">role</Link> from a job description,
          approve its scorecard, then add candidates to interview.
        </Banner>
      )}

      {metrics && k && (
        <>
          <section aria-labelledby="dash-kpis" data-tour="kpis">
            <h2 id="dash-kpis" className="dash-heading">Key metrics</h2>
            <ul className="kpi-grid">
              <Kpi icon="role" label="Open roles" value={k.openRoles} hint="Draft or approved" />
              <Kpi icon="candidates" label="Candidates" value={k.candidates} to="/candidates" hint="You can access" />
              <Kpi icon="funnel" label="In pipeline" value={k.activePipelines} hint="Active, not yet decided" />
              <Kpi icon="schedule" label="Scheduled" value={k.scheduledNext7Days} to="/interviews" hint="Next 7 days" />
              <Kpi icon="check-circle" label="Completed" value={k.completedLast30Days} hint="Last 30 days" />
              <Kpi icon="eye" label="Awaiting review" value={k.awaitingReview} to="/interviews" hint="AI interviews ready for a person" />
              <Kpi icon="clock" label="Invite to interview" value={formatHours(k.avgInviteToCompleteHours)} hint="Average, last 90 days" />
              <Kpi
                icon="scale"
                label="Approved"
                value={k.decisions.APPROVED}
                hint={`${k.decisions.REJECTED} rejected · ${k.decisions.WITHDRAWN} withdrawn`}
              />
            </ul>
          </section>

          <section aria-labelledby="dash-charts" className="dash-charts" data-tour="trends">
            <h2 id="dash-charts" className="dash-heading">Trends</h2>
            <div className="card dash-chart-wide">
              <h3>Interviews per week</h3>
              <p className="muted small">AI interviews and human rounds set up and completed, by rolling week.</p>
              <WeeklyColumnChart data={metrics.interviewsPerWeek} />
            </div>
            <div className="grid cols-2">
              <div className="card" data-tour="pipeline-stages">
                <h3>Pipeline by stage</h3>
                <p className="muted small">{inPipeline} active candidates, by current medallion stage.</p>
                <HorizontalBarChart items={stageItems} title="Active pipelines by stage" summary={`${inPipeline} active candidates.`} />
              </div>
              <div className="card">
                <h3>Interview status</h3>
                <p className="muted small">{totalInterviews} AI interviews, by where they are now.</p>
                <HorizontalBarChart items={stateItems} title="AI interviews by status" summary={`${totalInterviews} interviews.`} />
              </div>
            </div>
          </section>

          <section className="card" aria-labelledby="dash-recent" data-tour="recent-interviews">
            <div className="spread row" style={{ marginBottom: 8 }}>
              <h2 id="dash-recent" style={{ margin: 0 }}>Recent interviews</h2>
              <Link className="btn sm secondary" to="/interviews">View all</Link>
            </div>
            {metrics.recentInterviews.length === 0 ? (
              <div className="muted small">
                No interviews yet. <Link to="/candidates/new">Add a candidate</Link> to schedule one.
              </div>
            ) : (
              <div className="dash-table-wrap">
                <table>
                  <thead>
                    <tr><th>Candidate</th><th>Role</th><th>State</th><th>Date</th><th><span className="dash-sr-only">Actions</span></th></tr>
                  </thead>
                  <tbody>
                    {metrics.recentInterviews.map((row) => {
                      const date = interviewDate(row);
                      return (
                        <tr key={row.id}>
                          <td><Link to={`/candidates/${row.candidate.id}`}>{row.candidate.name}</Link></td>
                          <td className="muted">{row.role.title}</td>
                          <td>{stateBadge(row.state)}</td>
                          <td className="small">
                            <span className="muted">{date.label}</span> {new Date(date.at).toLocaleDateString()}
                          </td>
                          <td><Link to={`/interviews/${row.id}`}>Open</Link></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
