import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { stateBadge, Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { formatScoreOutOf100, hasScore } from '../components/scoreFormat';

interface CandidateFit { overall: number; confidence: number }
interface LatestInterview { id: string; state: string }
interface CandidateRow {
  id: string; fullName: string; email: string;
  roleId: string | null; roleTitle: string | null;
  fit: CandidateFit | null;
  latestInterview: LatestInterview | null;
  createdAt: string;
}

/**
 * States an interview will not leave on its own.
 *
 * Everything else is mid-flight: the candidate is part-way through, or waiting
 * on an invitation they have not acted on. That distinction is the whole point
 * of the marker below — a recruiter scanning this list needs to spot the person
 * who abandoned an interview two weeks ago without opening every row to find
 * out. Kept as a deny-list of endings rather than an allow-list of in-progress
 * states so a newly added intermediate state is treated as "still running"
 * (visible, chased) rather than silently reading as finished.
 */
const TERMINAL_STATES = new Set([
  'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED', 'ACCEPTED',
  'CANCELLED', 'NO_SHOW', 'TECHNICAL_FAILURE', 'POLICY_STOP', 'CANDIDATE_WITHDREW',
  // Started, then stopped responding. Terminal so it leaves the chase list —
  // it was showing as "in progress" for hours after the tab was closed.
  'INCOMPLETE',
]);

/**
 * States where the candidate has been invited but has not yet begun. Nothing is
 * happening and nothing is stuck — someone simply has not turned up yet.
 */
const NOT_STARTED_STATES = new Set(['PROVISIONED', 'INVITED']);

export function isInFlight(state: string | null | undefined): boolean {
  return !!state && !TERMINAL_STATES.has(state);
}

/** Invited, not yet started. */
export function isAwaitingCandidate(state: string | null | undefined): boolean {
  return !!state && NOT_STARTED_STATES.has(state);
}

/** Actually part-way through an interview. */
export function isUnderway(state: string | null | undefined): boolean {
  return isInFlight(state) && !isAwaitingCandidate(state);
}

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

export function CandidatesList() {
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ candidates: CandidateRow[] }>('/candidates')
      .then((d) => setCandidates(d.candidates ?? []))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Client-side because the endpoint returns the caller's whole scoped pipeline
  // in one call; a round trip per keystroke would be slower than filtering what
  // is already here.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) =>
      [c.fullName, c.email, c.roleTitle ?? ''].some((field) => field.toLowerCase().includes(q)));
  }, [candidates, query]);

  if (loading) return <PageSkeleton label="Loading candidates…" />;

  // Counted apart because they need different action. Someone who never started
  // gets a nudge; someone who stopped half-way needs looking at, and may have
  // hit a fault worth knowing about.
  const notStarted = candidates.filter((c) => isAwaitingCandidate(c.latestInterview?.state)).length;
  const underway = candidates.filter((c) => isUnderway(c.latestInterview?.state)).length;

  return (
    <div>
      <PageHeader
        icon="candidates"
        title="Candidates"
        actions={<Link className="btn secondary" to="/candidates/new"><Icon name="add-candidate" size={16} />Add Candidate</Link>}
      />

      {error && <Banner kind="error">{error}</Banner>}

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

      <div className="card">
        <div className="row spread" style={{ marginBottom: 12 }}>
          <input
            className="filter-input"
            placeholder="Filter by name, email or role…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter candidates"
          />
          <span className="muted small">
            {filtered.length === candidates.length
              ? `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`
              : `${filtered.length} of ${candidates.length}`}
          </span>
        </div>

        {candidates.length === 0 ? (
          <EmptyState
            icon="candidates"
            illustration="/brand/empty-candidates.webp"
            title="No candidates yet"
            message="Add a candidate and their resume to see their fit and set up a first-round interview."
            action={<Link className="btn" to="/candidates/new"><Icon name="add-candidate" size={16} />Add candidate</Link>}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            icon="search"
            title="No matches"
            message={`No candidate matches “${query}”.`}
            action={<button type="button" className="btn secondary sm" onClick={() => setQuery('')}><Icon name="close" size={14} />Clear filter</button>}
          />
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Candidates">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Role</th><th>Fit</th>
                <th>Interview</th><th>Added</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className={isInFlight(c.latestInterview?.state) ? 'in-flight' : undefined}>
                  <td><Link to={`/candidates/${c.id}`}>{c.fullName}</Link></td>
                  <td className="muted">{c.email}</td>
                  <td>
                    {c.roleId && c.roleTitle
                      ? <Link to={`/roles/${c.roleId}`}>{c.roleTitle}</Link>
                      : <span className="muted">—</span>}
                  </td>
                  {/* A fit row stored before `overall` existed still has a fit
                      object, so "c.fit ?" is not the question — "is there a
                      number?" is. */}
                  <td className={hasScore(c.fit?.overall) ? undefined : 'muted'}>{formatScoreOutOf100(c.fit?.overall)}</td>
                  <td>{interviewCell(c.latestInterview)}</td>
                  <td className="muted small">{new Date(c.createdAt).toLocaleDateString()}</td>
                  <td>
                    {/* The interview shortcut matters more than it looks: until this
                        page existed, a candidate whose interview had not produced an
                        assessment had no route to it from anywhere in the app. */}
                    {c.latestInterview
                      ? <Link to={`/interviews/${c.latestInterview.id}`}><Icon name="interviews" size={15} />Interview</Link>
                      : <Link to={`/candidates/${c.id}`}>Open<Icon name="arrow-right" size={15} /></Link>}
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
