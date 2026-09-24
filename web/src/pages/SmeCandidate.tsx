import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { formatDateTime } from '../components/dateFormat';
import { SmeInterviewReader } from '../components/sme/SmeInterviewReader';
import { SmeReviewForm, type ExistingReview } from '../components/sme/SmeReviewForm';

interface ScorecardCompetency {
  id: string;
  name: string;
  definition: string;
  classification: string;
  requiredLevel: string;
  targetLevel: string;
  indicators: string[];
}

interface Detail {
  candidate: { id: string; name: string; email: string; phone: string; linkedinUrl: string };
  role: { id: string; title: string; level: string | null } | null;
  scorecard: {
    version: number;
    roleContext: string;
    outcomes: string[];
    responsibilities: string[];
    competencies: ScorecardCompetency[];
  } | null;
  interviews: Array<{ id: string; state: string; interviewer: string; completedAt: string | null; durationMinutes: number }>;
  review: ExistingReview | null;
}

/**
 * One candidate, as a subject-matter expert sees them.
 *
 * The candidate is named, which is the deliberate exception in an otherwise
 * very narrow role: the owner's position is that human assessment of a person
 * is the thing being asked for, and that the value of asking is learning where
 * a person and the machine read the same candidate differently
 * (docs/credentials-contract.md §3).
 *
 * What is not here is everything else. No pipeline, no stage, no other expert's
 * recommendation, and nothing about what the hiring team is leaning towards —
 * an expert who has been told the answer is no longer giving one.
 */
export function SmeCandidate() {
  const { id } = useParams();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<Detail>(`/sme/candidates/${id}`);
      setDetail(data);
      // The most recent interview, which is the one an expert has almost always
      // been asked about.
      setOpenSessionId((current) => current ?? data.interviews[0]?.id ?? null);
      setError('');
    } catch (err: unknown) {
      // 404 covers both "no such candidate" and "not yours", on purpose: the
      // second must not be distinguishable, or the id is confirmed to somebody
      // who was never cleared to know the person exists.
      setError(err instanceof ApiError && err.status === 404
        ? 'This candidate is not one you have been asked to assess.'
        : err instanceof Error ? err.message : 'Could not load this candidate.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <PageSkeleton label="Loading this candidate…" />;

  if (!detail) {
    return (
      <EmptyState
        heading="page"
        icon="lock"
        title="Not one of yours"
        message={error || 'This candidate is not one you have been asked to assess.'}
        action={<Link className="btn secondary" to="/sme"><Icon name="arrow-left" size={16} />Back to your assessments</Link>}
      />
    );
  }

  return (
    <div>
      <PageHeader
        icon="candidate-profile"
        title={detail.candidate.name}
        subtitle={detail.role ? `${detail.role.title}${detail.role.level ? ` · ${detail.role.level}` : ''}` : 'No role attached'}
      />

      {error && <Banner kind="error">{error}</Banner>}

      <div className="card">
        <h2 className="card-title"><Icon name="candidate-profile" />Who this is</h2>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <div><div className="muted small">Email</div><div>{detail.candidate.email}</div></div>
          {detail.candidate.phone && <div><div className="muted small">Phone</div><div>{detail.candidate.phone}</div></div>}
          {detail.candidate.linkedinUrl && (
            <div>
              <div className="muted small">LinkedIn</div>
              <div><a href={detail.candidate.linkedinUrl} target="_blank" rel="noreferrer noopener">{detail.candidate.linkedinUrl}</a></div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title"><Icon name="scorecard" />What the role asks for</h2>
        {!detail.scorecard ? (
          // A scorecard nobody has signed off is a work in progress, and an
          // assessment against one is an assessment against a moving standard.
          <p className="muted small">This role has no approved scorecard yet, so there is nothing settled to assess against.</p>
        ) : (
          <>
            {detail.scorecard.roleContext && <p>{detail.scorecard.roleContext}</p>}
            {detail.scorecard.outcomes.length > 0 && (
              <>
                <h3>What success looks like</h3>
                <ul>{detail.scorecard.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul>
              </>
            )}
            <h3>Competencies</h3>
            <ul style={{ paddingLeft: 18 }}>
              {detail.scorecard.competencies.map((competency) => (
                <li key={competency.id} style={{ marginBottom: 10 }}>
                  <strong>{competency.name}</strong>
                  <span className="muted small"> · {competency.classification} · needs {competency.requiredLevel}</span>
                  {competency.definition && <div>{competency.definition}</div>}
                  {competency.indicators.length > 0 && (
                    <div className="muted small">Look for: {competency.indicators.join('; ')}</div>
                  )}
                </li>
              ))}
            </ul>
            <p className="muted small">Read-only. Version {detail.scorecard.version}, as approved.</p>
          </>
        )}
      </div>

      {detail.interviews.length === 0 ? (
        <div className="card">
          <h2 className="card-title"><Icon name="interviews" />Interviews</h2>
          <p className="muted small">There is no interview for this candidate yet. You can still record a reading of the role against them.</p>
        </div>
      ) : (
        <>
          <div className="card">
            <h2 className="card-title"><Icon name="interviews" />Interviews</h2>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {detail.interviews.map((interview) => (
                <button
                  key={interview.id}
                  type="button"
                  className={`btn sm ${openSessionId === interview.id ? '' : 'secondary'}`}
                  aria-pressed={openSessionId === interview.id}
                  onClick={() => setOpenSessionId(interview.id)}
                >
                  {interview.interviewer}
                  {interview.completedAt ? ` · ${formatDateTime(interview.completedAt)}` : ` · ${interview.state}`}
                </button>
              ))}
            </div>
          </div>

          {openSessionId && <SmeInterviewReader candidateId={detail.candidate.id} sessionId={openSessionId} />}
        </>
      )}

      <SmeReviewForm
        candidateId={detail.candidate.id}
        sessionId={openSessionId}
        existing={detail.review}
        onSaved={(review) => setDetail((current) => (current ? { ...current, review } : current))}
      />
    </div>
  );
}
