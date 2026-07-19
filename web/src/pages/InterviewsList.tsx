import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { recBadge, stateBadge, Banner } from '../components/ui';

interface Session {
  id: string; state: string; provider: string; scheduledAt: string | null;
  candidate: { id: string; name: string }; role: { id: string; title: string };
  recommendation: string | null; assessmentId: string | null; invited: boolean; createdAt: string;
}

export function InterviewsList() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ sessions: Session[] }>('/interviews')
      .then((d) => setSessions(d.sessions ?? []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="muted">Loading…</div>;

  return (
    <div>
      <div className="topbar">
        <h1>Interviews</h1>
        <Link className="btn secondary" to="/candidates/new">Add Candidate</Link>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="card">
        {sessions.length === 0 ? (
          <div className="muted small">No interviews yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Candidate</th><th>Role</th><th>State</th><th>Provider</th>
                <th>Recommendation</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {(sessions ?? []).map((s) => (
                <tr key={s.id}>
                  <td>{s.candidate?.name}</td>
                  <td>{s.role?.title}</td>
                  <td>{stateBadge(s.state)}</td>
                  <td className="muted">{s.provider}</td>
                  <td>{recBadge(s.recommendation)}</td>
                  <td>
                    {s.assessmentId
                      ? <Link to={`/assessments/${s.assessmentId}`}>View assessment</Link>
                      : <Link to={`/interviews/${s.id}`}>Open</Link>}
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
