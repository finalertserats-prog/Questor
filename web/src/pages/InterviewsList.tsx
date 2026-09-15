import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { recBadge, stateBadge, Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';

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

  if (loading) return <PageSkeleton label="Loading interviews…" />;

  return (
    <div>
      <PageHeader
        icon="interviews"
        title="Interviews"
        actions={<Link className="btn secondary" to="/candidates/new"><Icon name="add-candidate" size={16} />Add Candidate</Link>}
      />

      {error && <Banner kind="error">{error}</Banner>}

      <div className="card">
        {sessions.length === 0 ? (
          <EmptyState
            icon="interviews"
            illustration="/brand/empty-interviews.webp"
            title="No interviews yet"
            message="Interviews are set up from a candidate’s page. Add a candidate to create the first one."
            action={<Link className="btn" to="/candidates/new"><Icon name="add-candidate" size={16} />Add candidate</Link>}
          />
        ) : (
          <div className="table-scroll">
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
