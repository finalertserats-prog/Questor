import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { stateBadge, Banner } from '../components/ui';

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
]);

export function isInFlight(state: string | null | undefined): boolean {
  return !!state && !TERMINAL_STATES.has(state);
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
  return (
    <span className="row" style={{ gap: 6 }}>
      {stateBadge(iv.state)}
      {isInFlight(iv.state) && <span className="inflight-note">in progress</span>}
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

  if (loading) return <div className="muted">Loading…</div>;

  const stuck = candidates.filter((c) => isInFlight(c.latestInterview?.state)).length;

  return (
    <div>
      <div className="topbar">
        <h1>Candidates</h1>
        <Link className="btn secondary" to="/candidates/new">Add Candidate</Link>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {stuck > 0 && (
        <Banner kind="info">
          {stuck === 1 ? '1 candidate has' : `${stuck} candidates have`} an interview still in
          progress — they may be waiting on an invitation or have stopped part-way through.
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
          <div className="muted small">
            No candidates yet. <Link to="/candidates/new">Add one</Link> to get started.
          </div>
        ) : filtered.length === 0 ? (
          <div className="muted small">No candidate matches “{query}”.</div>
        ) : (
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
                  <td>{c.fit ? `${Math.round(c.fit.overall)}/100` : <span className="muted">—</span>}</td>
                  <td>{interviewCell(c.latestInterview)}</td>
                  <td className="muted small">{new Date(c.createdAt).toLocaleDateString()}</td>
                  <td>
                    {/* The interview shortcut matters more than it looks: until this
                        page existed, a candidate whose interview had not produced an
                        assessment had no route to it from anywhere in the app. */}
                    {c.latestInterview
                      ? <Link to={`/interviews/${c.latestInterview.id}`}>Interview</Link>
                      : <Link to={`/candidates/${c.id}`}>Open</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
