import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { formatDate, formatScheduled } from '../components/dateFormat';
import { roundZoneNote, smeRecommendationLabel, SME_ADVISORY_NOTE, type SeatedRound } from '../components/smeModel';

interface Assignment {
  candidateId: string;
  name: string;
  role: { id: string; title: string; level: string | null } | null;
  /** The round they are seated on: the next one, else the last one there was. */
  round: SeatedRound | null;
  review: { recommendation: string; updatedAt: string } | null;
}

/**
 * Everything a subject-matter expert is looking at, which is a list of people
 * somebody asked them to assess.
 *
 * Not a filtered candidate list — there is no unfiltered one behind it. The
 * server's /api/sme surface is the whole of what this role can reach, and it
 * answers with the people they were handed by name and nothing else.
 *
 * The names are here deliberately. An expert sees who the candidate is; that is
 * the owner's decision, on the grounds that assessing a person is what they
 * were asked to do (docs/credentials-contract.md §3).
 */
export function SmeWorkbench() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  // The organisation's zone comes back with the worklist rather than from
  // /interviews/time-zone, which this role is not allowed to call. Reading it
  // through a refused request would have silently assumed IST.
  const [orgTimeZone, setOrgTimeZone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A failed read is not an empty worklist.
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ assignments: Assignment[]; orgTimeZone: string | null }>('/sme/assignments');
      setAssignments(data.assignments ?? []);
      setOrgTimeZone(data.orgTimeZone ?? null);
      setError('');
      setLoadFailed(false);
    } catch (err: unknown) {
      setLoadFailed(true);
      setError(err instanceof ApiError && err.status === 403
        ? 'This page is for subject-matter experts.'
        : err instanceof Error ? err.message : 'Could not load your assessments.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <PageSkeleton label="Loading your assessments…" />;

  const waiting = assignments.filter((a) => !a.review);

  return (
    <div>
      <PageHeader
        icon="evidence-review"
        title="Your assessments"
        subtitle="Candidates the hiring team has asked you to read."
      />

      {error && <Banner kind="error">{error}</Banner>}

      <div className="card">
        {assignments.length === 0 && loadFailed ? (
          <div className="row" style={{ gap: 8 }}>
            <span className="muted small">Your assessments could not be read, so this list is not known to be complete.</span>
            <button type="button" className="btn secondary sm" onClick={() => { setLoading(true); void load(); }}>
              <Icon name="refresh" size={14} />Try again
            </button>
          </div>
        ) : assignments.length === 0 ? (
          <EmptyState
            icon="evidence-review"
            title="Nothing to read yet"
            message="When the hiring team asks you to assess a candidate, they appear here."
          />
        ) : (
          <>
            {/* Said before the list rather than beside each row: an expert
                should know what their answer does before they start writing
                one, not after. */}
            <p className="muted small" style={{ marginTop: 0, marginBottom: 14 }}>{SME_ADVISORY_NOTE}</p>

            <div className="table-scroll" tabIndex={0} role="region" aria-label="Candidates you have been asked to assess">
              <table>
                <thead>
                  <tr>
                    <th>Candidate</th><th>Role</th><th>Interview</th><th>Your recommendation</th><th><span className="visually-hidden">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((assignment) => (
                    <tr key={assignment.candidateId}>
                      <td><div className="signup-who">{assignment.name}</div></td>
                      <td>
                        {assignment.role ? assignment.role.title : <span className="muted small">No role yet</span>}
                        {assignment.role?.level && <div className="muted small">{assignment.role.level}</div>}
                      </td>
                      <td>
                        {assignment.round ? (
                          <>
                            <div>{formatScheduled(assignment.round.scheduledAt, assignment.round.scheduledTimeZone, orgTimeZone)}</div>
                            {roundZoneNote(assignment.round) && <div className="muted small">{roundZoneNote(assignment.round)}</div>}
                          </>
                        ) : (
                          <span className="muted small">Not in the room</span>
                        )}
                      </td>
                      <td>
                        {assignment.review ? (
                          <>
                            {smeRecommendationLabel(assignment.review.recommendation)}
                            <div className="muted small">{formatDate(assignment.review.updatedAt)}</div>
                          </>
                        ) : (
                          <span className="muted small">Not yet</span>
                        )}
                      </td>
                      <td>
                        <Link className="btn sm secondary" to={`/sme/candidates/${assignment.candidateId}`}>
                          {assignment.review ? 'Revisit' : 'Read'}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {waiting.length > 0 && (
              <p className="muted small" style={{ marginTop: 14 }}>
                {waiting.length === 1 ? 'One candidate is' : `${waiting.length} candidates are`} still waiting on you.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
