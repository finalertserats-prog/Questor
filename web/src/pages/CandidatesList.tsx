import { useMemo, useState } from 'react';
import { useAuth } from '../auth';
import { can } from '../components/capabilityModel';
import { Link } from 'react-router-dom';
import { stateBadge, Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { formatScoreOutOf100, hasScore } from '../components/scoreFormat';
import { roleDisplayLabels, type RoleLabelSource } from '../components/roleLabelModel';
import { alsoInRolesLabel } from '../components/candidateReuseModel';
import { SetUpForAnotherRole } from '../components/SetUpForAnotherRole';
import { formatDate } from '../components/dateFormat';
import { isAwaitingCandidate, isInFlight, isUnderway } from '../components/interviewFlight';
import { usePagedList } from '../components/usePagedList';
import { ListPager } from '../components/ListPager';
import { ResponsiveList, type ListCard } from '../components/ResponsiveList';
import { candidateNextAction } from '../components/listCardModel';
import type { PageMeta } from '../components/listPagingModel';
import { FIT_PROVISIONAL_LABEL, FIT_PROVISIONAL_NOTE } from '../components/fit/fitVocabulary';

/** `provisional` is absent on a row stored before the flag existed; absent is not "yes". */
interface CandidateFit { overall: number; confidence: number; provisional?: boolean }
interface LatestInterview { id: string; state: string }
interface CandidateRow {
  id: string; fullName: string; email: string;
  roleId: string | null; roleTitle: string | null;
  roleLevel?: string | null; roleRegionCode?: string | null; roleExperienceBand?: string | null;
  fit: CandidateFit | null;
  latestInterview: LatestInterview | null;
  /** The pipeline stage reached, named as the role names it; absent on an older server. */
  stage?: { key: string; label: string; decision: string | null } | null;
  /** Other roles the same person is in, among the ones the viewer may see. */
  alsoInRoles?: number;
  createdAt: string;
}

interface CandidatesPayload {
  candidates: CandidateRow[];
  meta?: PageMeta;
  /** Same-titled roles in scope, so labels tell them apart. */
  roles?: (RoleLabelSource & { id: string })[];
  /** Candidates by their latest interview's state, across every page. */
  summary?: { latestStateCounts: Record<string, number> };
}

export { isInFlight, isAwaitingCandidate, isUnderway } from '../components/interviewFlight';

/**
 * The state badge plus, for an unfinished interview, a plain-language note on
 * what is being waited for. The badge alone says INVITED; it does not say that
 * nobody is coming unless someone chases it.
 *
 * Lives beside the list rather than in components/ui.tsx because "unfinished"
 * is a judgement about operator workflow, not a rendering primitive.
 */
export function interviewCell(iv: LatestInterview | null) {
  if (!iv) return <span className="muted">—</span>;
  // "in progress" against an INVITED candidate was wrong and actively
  // misleading: it read as though ten people were mid-interview when nobody had
  // started. The two states need different words because they need different
  // actions — one is chased, the other is only waited on.
  return (
    <span className="row" style={{ gap: 6 }}>
      {stateBadge(iv.state)}
      {isAwaitingCandidate(iv.state) && <span className="inflight-note">not started yet</span>}
      {isUnderway(iv.state) && <span className="inflight-note">in progress</span>}
    </span>
  );
}

/** Candidates whose latest interview is in a state the predicate picks, across every page. */
function countLatest(counts: Record<string, number> | undefined, pick: (state: string) => boolean): number {
  return Object.entries(counts ?? {}).reduce((sum, [state, n]) => (pick(state) ? sum + n : sum), 0);
}

/** The stage a candidate has reached, as the card's badge: a ringed label, never a fill. */
function stageTag(stage: CandidateRow['stage']) {
  if (!stage) return undefined;
  if (stage.decision === 'REJECTED') return <span className="list-tier is-rejected">{stage.label} · not progressing</span>;
  if (stage.decision === 'APPROVED') return <span className="list-tier is-approved">{stage.label} · approved</span>;
  return <span className="list-tier">{stage.label}</span>;
}

export function CandidatesList() {
  // Adding a candidate needs candidate:create, which managers and reviewers lack.
  const mayAdd = can(useAuth().user, 'candidate:create');
  const paged = usePagedList<CandidatesPayload>({ list: 'candidates', base: '/candidates', failureMessage: 'Could not load candidates.' });
  const candidates = paged.data?.candidates ?? [];
  // The row whose "Set up for another role" panel is open.
  const [reuseFor, setReuseFor] = useState<CandidateRow | null>(null);

  // Labelled across the same-titled roles in scope (sent with the page), so a
  // role's label does not change from one page to the next.
  const roleLabelById = useMemo(() => {
    const roles = paged.data?.roles ?? [];
    const labels = roleDisplayLabels(roles);
    return new Map(roles.map((role, index) => [role.id, labels[index]]));
  }, [paged.data]);

  if (paged.loading) return <PageSkeleton label="Loading candidates…" />;

  // Counted apart because they need different action. Someone who never started
  // gets a nudge; someone who stopped half-way needs looking at, and may have
  // hit a fault worth knowing about. Counted by the server across every page.
  const counts = paged.data?.summary?.latestStateCounts;
  const notStarted = countLatest(counts, isAwaitingCandidate);
  const underway = countLatest(counts, isUnderway);
  const { meta, query } = paged;
  const roleName = (c: CandidateRow): string | null => (c.roleId && c.roleTitle ? roleLabelById.get(c.roleId) ?? c.roleTitle : null);
  const anotherRole = (c: CandidateRow) => (
    <button type="button" className="link-button link-action" onClick={() => setReuseFor(c)} aria-label={`Set up ${c.fullName} for another role`}>
      <Icon name="role" size={15} />Another role
    </button>
  );

  const cards: ListCard[] = candidates.map((c) => ({
    key: c.id,
    testId: 'candidate-card',
    title: <Link to={`/candidates/${c.id}`}>{c.fullName}</Link>,
    badge: stageTag(c.stage),
    lines: [
      <span className="muted">
        {roleName(c) ?? 'No role'}
        {(c.alsoInRoles ?? 0) > 0 ? ` · ${alsoInRolesLabel(c.alsoInRoles ?? 0).toLowerCase()}` : ''}
      </span>,
      // No dash line for someone not yet interviewed: the next step says so.
      ...(c.latestInterview ? [interviewCell(c.latestInterview)] : []),
    ],
    next: candidateNextAction(c),
    extra: mayAdd ? anotherRole(c) : undefined,
  }));

  const table = (
    <table>
      <thead>
        <tr>
          <th>Name</th><th>Email</th><th>Role</th>
          {/* From the resume against the role's scorecard, before any
              interview. Named so, because a bare "Fit" beside an
              interview column read as an interview result. */}
          <th><abbr title="Scored from the resume against the role's scorecard. Not an interview result.">Resume fit</abbr></th>
          <th>Interview</th><th>Added</th><th><span className="visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((c) => (
          <tr key={c.id} className={isInFlight(c.latestInterview?.state) ? 'in-flight' : undefined}>
            <td><Link to={`/candidates/${c.id}`}>{c.fullName}</Link></td>
            <td className="muted">{c.email}</td>
            <td>
              {c.roleId && c.roleTitle
                ? <Link to={`/roles/${c.roleId}`}>{roleName(c)}</Link>
                : <span className="muted">—</span>}
              {(c.alsoInRoles ?? 0) > 0 && (
                <div className="muted small">{alsoInRolesLabel(c.alsoInRoles ?? 0)}</div>
              )}
            </td>
            {/* A fit row stored before `overall` existed still has a fit
                object, so "c.fit ?" is not the question — "is there a
                number?" is.

                A provisional number was read against a scorecard nobody has
                approved. It is shown, because hiding it would hide the draft
                that produced it, and it is labelled, because this list is
                exactly where an unlabelled number becomes a ranking in the
                reader's head. Nothing on this page sorts or filters by it. */}
            <td className={hasScore(c.fit?.overall) ? undefined : 'muted'}>
              {formatScoreOutOf100(c.fit?.overall)}
              {hasScore(c.fit?.overall) && c.fit?.provisional === true && (
                <div className="muted small" data-testid="fit-provisional-row" title={FIT_PROVISIONAL_NOTE}>{FIT_PROVISIONAL_LABEL}</div>
              )}
            </td>
            <td>{interviewCell(c.latestInterview)}</td>
            <td className="muted small">{formatDate(c.createdAt)}</td>
            <td>
              {/* The interview shortcut matters more than it looks: until this
                  page existed, a candidate whose interview had not produced an
                  assessment had no route to it from anywhere in the app. */}
              <span className="row" style={{ gap: 10 }}>
                {c.latestInterview
                  ? <Link to={`/interviews/${c.latestInterview.id}`}><Icon name="interviews" size={15} />Interview</Link>
                  : <Link to={`/candidates/${c.id}`}>Open<Icon name="arrow-right" size={15} /></Link>}
                {mayAdd && anotherRole(c)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div>
      <PageHeader
        icon="candidates"
        title="Candidates"
        actions={mayAdd ? (
          <>
            <Link className="btn secondary" to="/candidates/import"><Icon name="resume-upload" size={16} />Add candidates</Link>
            <Link className="btn secondary" to="/candidates/new"><Icon name="add-candidate" size={16} />Add candidate</Link>
          </>
        ) : undefined}
      />

      {paged.error && <Banner kind="error">{paged.error}</Banner>}

      {notStarted > 0 && (
        <Banner kind="info">
          {notStarted === 1
            ? '1 candidate has been invited but has not started yet.'
            : `${notStarted} candidates have been invited but have not started yet.`}
          {' '}Nothing is wrong — they have not opened their interview.
        </Banner>
      )}

      {underway > 0 && (
        <Banner kind="info">
          {underway === 1
            ? '1 candidate started an interview and has not finished it.'
            : `${underway} candidates started an interview and have not finished it.`}
          {' '}Worth opening — they may have stopped part-way, or hit a problem.
        </Banner>
      )}

      {reuseFor && (
        <SetUpForAnotherRole
          key={reuseFor.id}
          candidateId={reuseFor.id}
          fullName={reuseFor.fullName}
          email={reuseFor.email}
          onClose={() => setReuseFor(null)}
          onApplied={paged.reload}
        />
      )}

      <div className="card">
        <div className="row spread list-toolbar">
          <input
            className="filter-input"
            type="search"
            placeholder="Search by name, email or role…"
            value={paged.draft}
            maxLength={200}
            onChange={(e) => paged.setDraft(e.target.value)}
            aria-label="Search candidates"
          />
          {paged.refreshing && <span className="muted small">Loading…</span>}
        </div>

        {meta.total === 0 && !query ? (
          paged.error ? null : (
            <EmptyState
              icon="candidates"
              illustration="/brand/empty-candidates.webp"
              title="No candidates yet"
              message="Add a candidate and their resume to see their fit and set up a first-round interview."
              action={mayAdd ? <Link className="btn" to="/candidates/new"><Icon name="add-candidate" size={16} />Add candidate</Link> : undefined}
            />
          )
        ) : meta.total === 0 ? (
          <EmptyState
            compact
            icon="search"
            title="No matches"
            message={`No candidate matches “${query}”.`}
            action={<button type="button" className="btn secondary sm" onClick={paged.clearSearch}><Icon name="close" size={14} />Clear search</button>}
          />
        ) : (
          <>
            <ResponsiveList label="Candidates" table={table} cards={cards} />
            <ListPager
              meta={meta}
              pageSize={paged.pageSize}
              noun="candidate"
              label="Candidates"
              onPage={paged.setPage}
              onPageSize={paged.setPageSize}
            />
          </>
        )}
      </div>
    </div>
  );
}
