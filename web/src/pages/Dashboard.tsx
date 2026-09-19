import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { Banner, stateBadge } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { WorkflowDiagram } from '../components/WorkflowDiagram';
import { HorizontalBarChart, WeeklyColumnChart, type BarItem, type WeekPoint } from '../components/DashboardCharts';
import { EmptyState } from '../components/EmptyState';
import { chartTone, formatHours, groupSessionStates, trimSparseWeeks, truncationNote } from '../components/dashboardModel';
import { canReadAudit } from '../components/profileMenuModel';
import { roleDisplayLabels, type RoleLabelSource } from '../components/roleLabelModel';
import type { TopRole } from '../components/rolesListModel';

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
  /** Set by the server when the series came from a capped row set, not from everything. */
  truncated?: boolean;
  recentInterviews: {
    id: string; state: string; createdAt: string; scheduledAt: string | null; completedAt: string | null;
    candidate: { id: string; name: string }; role: RoleLabelSource & { id: string };
  }[];
  roles?: {
    kpis: { activeRoles: number; rolesWithoutCandidates: number; rolesWithReviewBacklog: number };
    topByApplied: TopRole[];
    topByInterviewed: TopRole[];
    minSample: number;
  };
}

interface KpiProps {
  icon: IconName;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  to?: string;
  /** Marks the one measure on the page that is asking a person to act. */
  spark?: boolean;
}

function Kpi({ icon, label, value, hint, to, spark }: KpiProps) {
  const cls = spark ? 'kpi-link kpi-link--spark' : 'kpi-link';
  const body = (
    <>
      <span className="kpi-icon"><Icon name={icon} size={18} /></span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </>
  );
  return <li className="kpi">{to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>}</li>;
}

/** The date that matters most for where an interview is in its life. */
function interviewDate(row: Metrics['recentInterviews'][number]): { label: string; at: string } {
  if (row.completedAt) return { label: 'Completed', at: row.completedAt };
  if (row.scheduledAt) return { label: 'Scheduled', at: row.scheduledAt };
  return { label: 'Created', at: row.createdAt };
}

/** Ranked roles as bars, with same-titled roles told apart by their labels. */
function toRoleBars(roles: readonly TopRole[], tone: string): BarItem[] {
  const labels = roleDisplayLabels(roles);
  return roles.map((r, index) => ({ key: r.id, label: labels[index], count: r.count, tone, to: `/roles/${r.id}` }));
}

export function Dashboard() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  // `cancelled` so a slow metrics response cannot set state on a page the
  // person has already left.
  useEffect(() => {
    let cancelled = false;
    api.get<Metrics>('/dashboard/metrics?weeks=12&recent=8')
      .then((d) => { if (!cancelled) setMetrics(d); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError({
          status: err instanceof ApiError ? err.status : 0,
          message: err instanceof Error ? err.message : 'Could not load dashboard metrics.',
        });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const k = metrics?.kpis;
  const stageItems: BarItem[] = (metrics?.pipelineStages ?? []).map((s) => ({ ...s, tone: 'tone-accent' }));
  const stateItems: BarItem[] = groupSessionStates(metrics?.stateCounts ?? {}).map((g) => ({ ...g, tone: chartTone(g.key) }));
  const inPipeline = stageItems.reduce((sum, s) => sum + s.count, 0);
  const totalInterviews = stateItems.reduce((sum, s) => sum + s.count, 0);
  const stopped = stateItems.find((g) => g.key === 'stopped')?.count ?? 0;
  const weeklyData = trimSparseWeeks(metrics?.interviewsPerWeek ?? []);
  const topRoleApplied = toRoleBars(metrics?.roles?.topByApplied ?? [], 'tone-accent');
  const topRoleInterviewed = toRoleBars(metrics?.roles?.topByInterviewed ?? [], 'tone-pass');
  const recent = metrics?.recentInterviews ?? [];
  const recentRoleLabels = roleDisplayLabels(recent.map((row) => row.role));
  const truncation = truncationNote(metrics?.truncated);

  return (
    <div className="dashboard">
      <div className="topbar">
        <h1>Dashboard</h1>
        <div className="row">
          <Link className="btn" to="/roles/new">New role</Link>
          <Link className="btn secondary" to="/candidates">Candidates</Link>
          <Link className="btn secondary" to="/candidates/new">Add candidate</Link>
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
              {/* One roles count, not two: "Open roles" and "Active roles" were
                  the same number under two names. The role metrics' version
                  links to the list; an older server only has this one. */}
              {!metrics.roles && <Kpi icon="jobs" label="Open roles" value={k.openRoles} to="/roles" hint="Draft or approved" />}
              <Kpi icon="candidates" label="Candidates" value={k.candidates} to="/candidates" hint="You can access" />
              <Kpi icon="funnel" label="In pipeline" value={k.activePipelines} hint="Active, not yet decided" />
              {/* Both counts include the human rounds, not only the AI sessions
                  the list they link to shows. Said in the hint rather than left
                  for someone to discover by counting rows. */}
              <Kpi icon="schedule" label="Scheduled" value={k.scheduledNext7Days} to="/interviews" hint="AI interviews and human rounds, next 7 days" />
              <Kpi icon="check-circle" label="Completed" value={k.completedLast30Days} hint="AI interviews and human rounds, last 30 days" />
              <Kpi icon="human-review" label="Interviews awaiting review" value={k.awaitingReview} to="/interviews?state=review" hint="AI interviews ready for a person" spark />
              <Kpi
                icon="user-x"
                label="Stopped"
                value={stopped}
                to="/interviews?state=stopped"
                hint="No-show, withdrew or cut short"
              />
              {/* It measures invitation to COMPLETED interview, which is a
                  longer thing than the old label described. */}
              <Kpi icon="clock" label="Invite → completed (average)" value={formatHours(k.avgInviteToCompleteHours)} hint="Mean time, last 90 days" />
              <Kpi
                icon="decision"
                label="Approved"
                value={k.decisions.APPROVED}
                hint={`${k.decisions.REJECTED} rejected · ${k.decisions.WITHDRAWN} withdrawn`}
              />
              {metrics.roles && (
                <>
                  <Kpi icon="role" label="Active roles" value={metrics.roles.kpis.activeRoles} to="/roles" hint="Draft or approved" />
                  <Kpi icon="inbox" label="Roles with no candidates" value={metrics.roles.kpis.rolesWithoutCandidates} to="/roles?filter=no-candidates" hint="Active roles" />
                  <Kpi icon="eye" label="Roles awaiting review" value={metrics.roles.kpis.rolesWithReviewBacklog} to="/roles?filter=awaiting-review" hint="Roles with at least one review-ready interview" />
                </>
              )}
            </ul>
          </section>

          <section aria-labelledby="dash-charts" className="dash-charts" data-tour="trends">
            <h2 id="dash-charts" className="dash-heading">Trends</h2>
            <div className="card dash-chart-wide">
              <h3>Interviews per week</h3>
              <p className="muted small">AI interviews and human rounds set up and completed, by rolling week.</p>
              <WeeklyColumnChart data={weeklyData} />
            </div>
            <div className="grid cols-2">
              <div className="card" data-tour="pipeline-stages">
                <h3>Pipeline by stage</h3>
                {/* A stacked run of zero-length bars is a chart drawing nothing.
                    When every stage is empty the reason is worth more than the
                    shape of it. */}
                {inPipeline === 0 ? (
                  <EmptyState
                    compact
                    icon="funnel"
                    title="No active pipelines"
                    message="A candidate joins the pipeline when you move them into a medallion stage. Nobody is in one yet."
                    action={<Link className="btn sm" to="/candidates">Go to candidates</Link>}
                  />
                ) : (
                  <>
                    <p className="muted small">{inPipeline} active candidates, by current medallion stage.</p>
                    <HorizontalBarChart items={stageItems} title="Active pipelines by stage" summary={`${inPipeline} active candidates.`} />
                  </>
                )}
              </div>
              <div className="card">
                <h3>Interview status</h3>
                {totalInterviews === 0 ? (
                  <EmptyState
                    compact
                    icon="interviews"
                    title="No interviews yet"
                    message="Set up an interview from a candidate’s page and its progress will show here."
                    action={<Link className="btn sm" to="/candidates/new">Add candidate</Link>}
                  />
                ) : (
                  <>
                    <p className="muted small">{totalInterviews} AI interviews, by where they are now.</p>
                    <HorizontalBarChart items={stateItems} title="AI interviews by status" summary={`${totalInterviews} interviews.`} />
                  </>
                )}
              </div>
            </div>
            {metrics.roles && (
              <div className="grid cols-2">
                <div className="card">
                  <div className="chart-card-head">
                    <h3>Top roles by candidates</h3>
                    <Link className="btn sm secondary" to="/roles">View all roles</Link>
                  </div>
                  {topRoleApplied.length === 0 ? (
                    <EmptyState compact icon="role" title="No role candidates yet" message="Add candidates to roles and the busiest roles will appear here." />
                  ) : (
                    <HorizontalBarChart items={topRoleApplied} title="Top roles by candidates" summary="Candidates attached to roles." />
                  )}
                </div>
                <div className="card">
                  <div className="chart-card-head">
                    <h3>Top roles by completed interviews</h3>
                    <Link className="btn sm secondary" to="/roles">View all roles</Link>
                  </div>
                  {topRoleInterviewed.length === 0 ? (
                    <EmptyState compact icon="interviews" title="No completed interviews yet" message="Completed interviews will rank roles here." />
                  ) : (
                    <HorizontalBarChart items={topRoleInterviewed} title="Top roles by completed interviews" summary="Distinct candidates with completed interviews." />
                  )}
                </div>
              </div>
            )}
            {/* Said once, under everything it applies to: these charts and the
                averages above them are not a picture of the whole tenant. */}
            {truncation && <p className="muted small">{truncation}</p>}
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
                    <tr><th>Candidate</th><th>Role</th><th>State</th><th>Date</th><th><span className="visually-hidden">Actions</span></th></tr>
                  </thead>
                  <tbody>
                    {metrics.recentInterviews.map((row, index) => {
                      const date = interviewDate(row);
                      return (
                        <tr key={row.id}>
                          <td><Link to={`/candidates/${row.candidate.id}`}>{row.candidate.name}</Link></td>
                          <td className="muted">{recentRoleLabels[index]}</td>
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
