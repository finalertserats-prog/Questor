import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, recBadge, stateBadge, Banner, Stat } from '../components/ui';
import { interviewCell, isInFlight } from './CandidatesList';

interface Analytics {
  funnel: { roles: number; candidates: number; interviews: number; completed: number };
  stateCounts: Record<string, number>;
  recommendations: Record<string, number>;
  reviews: number;
  quality: { avgEvidenceCoverage: number };
}
interface Session {
  id: string; state: string; provider: string; scheduledAt: string | null;
  candidate: { id: string; name: string }; role: { id: string; title: string };
  recommendation: string | null; assessmentId: string | null; invited: boolean; createdAt: string;
}
interface CandidateRow {
  id: string; fullName: string; email: string;
  roleId: string | null; roleTitle: string | null;
  fit: { overall: number } | null;
  latestInterview: { id: string; state: string } | null;
  createdAt: string;
}
interface Role {
  id: string; title: string; level: string; status: string;
  latestScorecard: { id: string; version: number; status: string } | null;
  candidates: number; updatedAt: string;
}

function statusKind(status: string): 'green' | 'amber' | 'gray' {
  return status === 'approved' ? 'green' : status === 'draft' ? 'amber' : 'gray';
}

export function Dashboard() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get<Analytics>('/admin/analytics'),
      api.get<{ sessions: Session[] }>('/interviews'),
      api.get<{ roles: Role[] }>('/roles'),
      api.get<{ candidates: CandidateRow[] }>('/candidates'),
    ])
      .then(([a, s, r, c]) => {
        setAnalytics(a); setSessions(s.sessions ?? []); setRoles(r.roles ?? []);
        setCandidates(c.candidates ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="muted">Loading…</div>;

  const f = analytics?.funnel;

  return (
    <div>
      <div className="topbar">
        <h1>Dashboard</h1>
        <div className="row">
          <Link className="btn" to="/roles/new">New Role</Link>
          <Link className="btn secondary" to="/candidates">Candidates</Link>
          <Link className="btn secondary" to="/candidates/new">Add Candidate</Link>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {roles.length === 0 && (
        <Banner kind="info">
          Getting started: create your first <Link to="/roles/new">role</Link> from a job description,
          approve its scorecard, then add candidates to interview.
        </Banner>
      )}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Roles" value={f?.roles ?? 0} />
        <Stat label="Candidates" value={f?.candidates ?? 0} />
        <Stat label="Interviews" value={f?.interviews ?? 0} />
        <Stat label="Completed" value={f?.completed ?? 0} />
      </div>

      {/* Above interviews on purpose: a newly added candidate has no interview
          yet, so the interviews table cannot show them at all. This is the first
          screen the operator sees, and it used to be possible for a candidate to
          be added and then be invisible everywhere in the app. */}
      <div className="card">
        <div className="spread row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Recent candidates</h2>
          <Link className="btn sm secondary" to="/candidates">View all</Link>
        </div>
        {candidates.length === 0 ? (
          <div className="muted small">
            No candidates yet. <Link to="/candidates/new">Add one</Link> to get started.
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Role</th><th>Fit</th><th>Interview</th><th>Added</th><th></th></tr>
            </thead>
            <tbody>
              {candidates.slice(0, 6).map((c) => (
                <tr key={c.id} className={isInFlight(c.latestInterview?.state) ? 'in-flight' : undefined}>
                  <td><Link to={`/candidates/${c.id}`}>{c.fullName}</Link></td>
                  <td className="muted">{c.roleTitle ?? '—'}</td>
                  <td>{c.fit ? `${Math.round(c.fit.overall)}/100` : <span className="muted">—</span>}</td>
                  <td>{interviewCell(c.latestInterview)}</td>
                  <td className="muted small">{new Date(c.createdAt).toLocaleDateString()}</td>
                  <td>
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

      <div className="card">
        <h2>Recent interviews</h2>
        {sessions.length === 0 ? (
          <div className="muted small">No interviews yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Candidate</th><th>Role</th><th>State</th><th>Recommendation</th><th></th></tr>
            </thead>
            <tbody>
              {(sessions ?? []).slice(0, 8).map((s) => (
                <tr key={s.id}>
                  <td>{s.candidate?.name}</td>
                  <td>{s.role?.title}</td>
                  <td>{stateBadge(s.state)}</td>
                  <td>{recBadge(s.recommendation)}</td>
                  <td><Link to={`/interviews/${s.id}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="spread row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Roles</h2>
          <Link className="btn sm" to="/roles/new">New Role</Link>
        </div>
        {roles.length === 0 ? (
          <div className="muted small">No roles yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Title</th><th>Level</th><th>Status</th><th>Candidates</th><th></th></tr>
            </thead>
            <tbody>
              {(roles ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{r.title}</td>
                  <td>{r.level}</td>
                  <td><Badge kind={statusKind(r.status)}>{r.status}</Badge></td>
                  <td>{r.candidates}</td>
                  <td><Link to={`/roles/${r.id}`}>View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
