import { useMemo } from 'react';
import { useAuth } from '../auth';
import { can } from '../components/capabilityModel';
import { Link, useSearchParams } from 'react-router-dom';
import { stateBadge, Banner } from '../components/ui';
import { VerdictCell } from '../components/VerdictCell';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { statesInGroup } from '../components/dashboardModel';
import { humanise } from '../components/statusModel';
import { roleDisplayLabels, type RoleLabelSource } from '../components/roleLabelModel';
import { formatScheduled } from '../components/dateFormat';
import { useOrgTimeZone } from '../components/useOrgTimeZone';
import { usePagedList } from '../components/usePagedList';
import { ListPager } from '../components/ListPager';
import { ResponsiveList, type ListCard } from '../components/ResponsiveList';
import { interviewNextAction } from '../components/listCardModel';
import type { PageMeta } from '../components/listPagingModel';

interface Session {
  id: string; state: string; provider: string; scheduledAt: string | null; scheduledTimeZone: string | null;
  candidate: { id: string; name: string }; role: (RoleLabelSource & { id: string }) | null;
  /** Left out, with blindReviewPending set, while your independent review comes first. */
  recommendation?: string | null; blindReviewPending?: boolean;
  assessmentId: string | null; invited: boolean; createdAt: string;
  /** The reviewer's verdict once there is one; absent on an older server or while blind review is pending. */
  humanRecommendation?: string | null;
}

interface SessionsPayload {
  sessions: Session[];
  meta?: PageMeta;
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
  const orgZone = useOrgTimeZone();
  const [params] = useSearchParams();

  // The dashboard links here with ?state=stopped. The states behind a group
  // come from the same table the dashboard chart uses, so the count on the KPI
  // and the rows on this page cannot drift apart. The server does the
  // narrowing, so it applies across every page, not just the one loaded.
  const group = params.get('state');
  const groupLabel = group ? FILTER_LABELS[group] : undefined;
  const states = groupLabel && group ? statesInGroup(group).join(',') : undefined;
  const extra = useMemo(() => ({ states }), [states]);
  const paged = usePagedList<SessionsPayload>({ list: 'interviews', base: '/interviews', extra, failureMessage: 'Could not load interviews.' });
  const sessions = paged.data?.sessions ?? [];
  const roleLabelById = useMemo(() => {
    const roles = (paged.data?.sessions ?? []).flatMap((s) => (s.role ? [s.role] : []));
    const labels = roleDisplayLabels(roles);
    return new Map(roles.map((role, index) => [role.id, labels[index]]));
  }, [paged.data]);

  if (paged.loading) return <PageSkeleton label="Loading interviews…" />;

  const { meta, query } = paged;
  const roleName = (s: Session) => (s.role ? roleLabelById.get(s.role.id) ?? s.role.title : null);

  const cards: ListCard[] = sessions.map((s) => ({
    key: s.id,
    testId: 'interview-card',
    title: <Link to={`/interviews/${s.id}`}>{s.candidate?.name}</Link>,
    badge: stateBadge(s.state),
    lines: [
      <span className="muted">{roleName(s) ?? 'No role'}</span>,
      <span className="small">{formatScheduled(s.scheduledAt, s.scheduledTimeZone, orgZone)}</span>,
      <VerdictCell row={s} />,
    ],
    next: interviewNextAction(s),
  }));

  const table = (
    <table>
      <thead>
        <tr>
          <th>Candidate</th><th>Role</th><th>State</th><th>Scheduled</th><th>Provider</th>
          <th>Recommendation</th><th>Action</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id}>
            <td>{s.candidate?.name}</td>
            <td>{roleName(s)}</td>
            <td>{stateBadge(s.state)}</td>
            <td className="small" data-testid={`interview-scheduled-${s.id}`}>{formatScheduled(s.scheduledAt, s.scheduledTimeZone, orgZone)}</td>
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
  );

  return (
    <div>
      <PageHeader
        icon="interviews"
        title={groupLabel ? `Interviews — ${groupLabel}` : 'Interviews'}
        actions={mayAdd ? <Link className="btn secondary" to="/candidates/new"><Icon name="add-candidate" size={16} />Add candidate</Link> : undefined}
      />

      {paged.error && <Banner kind="error">{paged.error}</Banner>}

      {/* An unlabelled filter is how someone concludes their interviews have
          vanished. Say what is being shown, and how to stop showing it. */}
      {groupLabel && (
        <Banner kind="info">
          Showing {meta.total} {meta.total === 1 ? 'interview' : 'interviews'}: {groupLabel.toLowerCase()}.{' '}
          <Link to="/interviews">Show all</Link>
        </Banner>
      )}

      <div className="card">
        <div className="row spread list-toolbar">
          <input
            className="filter-input"
            type="search"
            placeholder="Search by candidate or role…"
            value={paged.draft}
            maxLength={200}
            onChange={(e) => paged.setDraft(e.target.value)}
            aria-label="Search interviews"
          />
          {paged.refreshing && <span className="muted small">Loading…</span>}
        </div>

        {meta.total === 0 ? (
          query ? (
            <EmptyState
              compact
              icon="search"
              title="No matches"
              message={`No interview matches “${query}”.`}
              action={<button type="button" className="btn secondary sm" onClick={paged.clearSearch}><Icon name="close" size={14} />Clear search</button>}
            />
          ) : groupLabel ? (
            <EmptyState
              compact
              icon="interviews"
              title={`No ${groupLabel.toLowerCase()} interviews`}
              message="Nothing is in this state right now."
              action={<Link className="btn" to="/interviews">Show all interviews</Link>}
            />
          ) : paged.error ? null : (
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
          <>
            <ResponsiveList label="Interviews" table={table} cards={cards} />
            <ListPager
              meta={meta}
              pageSize={paged.pageSize}
              noun="interview"
              label="Interviews"
              onPage={paged.setPage}
              onPageSize={paged.setPageSize}
            />
          </>
        )}
      </div>
    </div>
  );
}
