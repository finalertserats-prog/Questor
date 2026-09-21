import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth';
import { can } from '../components/capabilityModel';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { stateBadge, Banner } from '../components/ui';
import { VerdictCell } from '../components/VerdictCell';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { statesInGroup } from '../components/dashboardModel';
import { humanise } from '../components/statusModel';
import { roleDisplayLabels, type RoleLabelSource } from '../components/roleLabelModel';

interface Session {
  id: string; state: string; provider: string; scheduledAt: string | null;
  candidate: { id: string; name: string }; role: (RoleLabelSource & { id: string }) | null;
  recommendation: string | null; assessmentId: string | null; invited: boolean; createdAt: string;
  /** The reviewer's verdict once there is one; absent on an older server. */
  humanRecommendation?: string | null;
}

/** Group keys this page will narrow to, and what to call the result. */
const FILTER_LABELS: Readonly<Record<string, string>> = {
  scheduled: 'Invited / scheduled',
  live: 'In progress',
  review: 'Awaiting review',
  reviewed: 'Reviewed / closed',
  stopped: 'Stopped',
};

export function InterviewsList() {
  // Adding a candidate needs candidate:create, which managers and reviewers lack.
  const mayAdd = can(useAuth().user, 'candidate:create');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [params] = useSearchParams();

  // The dashboard links here with ?state=stopped. The states behind a group
  // come from the same table the dashboard chart uses, so the count on the KPI
  // and the rows on this page cannot drift apart.
  const group = params.get('state');
  const groupLabel = group ? FILTER_LABELS[group] : undefined;
  const visible = useMemo(() => {
    const wanted = group ? statesInGroup(group) : [];
    if (!wanted.length) return sessions;
    return sessions.filter((s) => wanted.includes(s.state));
  }, [sessions, group]);
  const roleLabelById = useMemo(() => {
    const roles = sessions.flatMap((s) => (s.role ? [s.role] : []));
    const labels = roleDisplayLabels(roles);
    return new Map(roles.map((role, index) => [role.id, labels[index]]));
  }, [sessions]);

  // `cancelled` so a response that lands after someone has navigated away does
  // not set state on a page that is gone.
  useEffect(() => {
    let cancelled = false;
    api.get<{ sessions: Session[] }>('/interviews')
      .then((d) => { if (!cancelled) setSessions(d.sessions ?? []); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load interviews.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <PageSkeleton label="Loading interviews…" />;

  return (
    <div>
      <PageHeader
        icon="interviews"
        title={groupLabel ? `Interviews — ${groupLabel}` : 'Interviews'}
        actions={mayAdd ? <Link className="btn secondary" to="/candidates/new"><Icon name="add-candidate" size={16} />Add candidate</Link> : undefined}
      />

      {error && <Banner kind="error">{error}</Banner>}

      {/* An unlabelled filter is how someone concludes their interviews have
          vanished. Say what is being shown, and how to stop showing it. */}
      {groupLabel && (
        <Banner kind="info">
          Showing {visible.length} of {sessions.length} interviews: {groupLabel.toLowerCase()}.{' '}
          <Link to="/interviews">Show all</Link>
        </Banner>
      )}

      <div className="card">
        {visible.length === 0 ? (
          groupLabel ? (
            <EmptyState
              compact
              icon="interviews"
              title={`No ${groupLabel.toLowerCase()} interviews`}
              message="Nothing is in this state right now."
              action={<Link className="btn" to="/interviews">Show all interviews</Link>}
            />
          ) : (
            <EmptyState
              icon="interviews"
              illustration="/brand/empty-interviews.webp"
              illustrationWidth={360}
              illustrationHeight={331}
              title="No interviews yet"
              message="Interviews are set up from a candidate’s page. Add a candidate to create the first one."
              action={mayAdd ? <Link className="btn" to="/candidates/new"><Icon name="add-candidate" size={16} />Add candidate</Link> : undefined}
            />
          )
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Interviews">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th><th>Role</th><th>State</th><th>Provider</th>
                  <th>Recommendation</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id}>
                    <td>{s.candidate?.name}</td>
                    <td>{s.role ? roleLabelById.get(s.role.id) ?? s.role.title : null}</td>
                    <td>{stateBadge(s.state)}</td>
                    <td className="muted">{humanise(s.provider)}</td>
                    <td><VerdictCell row={s} /></td>
                    <td>
                      {s.assessmentId
                        ? <Link to={`/assessments/${s.assessmentId}`}><Icon name="evidence" size={15} />View assessment</Link>
                        : <Link to={`/interviews/${s.id}`}>Open<Icon name="arrow-right" size={15} /></Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
