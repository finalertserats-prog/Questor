import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Banner } from '../ui';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { formatDateTime } from '../dateFormat';
import { can, onlyWhoCan } from '../capabilityModel';
import { useAuth } from '../../auth';
import { awaitingSummary, SME_ADVISORY_NOTE } from '../smeModel';

interface AssignedSme {
  userId: string;
  name: string;
  email: string;
  assignedAt: string;
}

interface SmeReview {
  id: string;
  sme: { id: string; name: string };
  recommendation: string;
  recommendationLabel: string;
  feedback: string;
  updatedAt: string;
}

interface Panel {
  assigned: AssignedSme[];
  reviews: SmeReview[];
  awaiting: AssignedSme[];
}

/**
 * What the subject-matter experts made of this candidate, and who else could be
 * asked.
 *
 * This is the surface the whole SME role exists to feed, and the one place the
 * hiring team meets it. Three things are deliberate about how it reads.
 *
 * The recommendation is labelled as advice every time it is shown. A manager
 * looking at "Proceed" set in the same type as the reviewer's verdict will
 * reasonably assume the system acted on it, and it did not.
 *
 * The author is named. A recommendation nobody owns cannot be weighed, asked
 * about, or calibrated against later — which is also why colleagues are added
 * by invitation rather than by an admin choosing their password.
 *
 * Experts who were asked and have not answered are named too. "Asked, nothing
 * back yet" and "nobody was asked" look identical if only the answers are
 * listed, and they are very different things to decide on.
 */
export function SmeReviewPanel({ candidateId }: { candidateId: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [available, setAvailable] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A refused read is a state to explain, not a blank panel.
  const [refused, setRefused] = useState(false);

  const mayAssign = can(user, 'sme:assign');

  const load = useCallback(async () => {
    try {
      const data = await api.get<Partial<Panel>>(`/candidates/${candidateId}/sme`);
      // Each list defaulted rather than trusted. This panel sits on the
      // candidate page beside the pipeline and the interview setup, and it is
      // the newest thing on it: an answer from an older server, a proxy error
      // page, or any shape without these three keys would otherwise throw
      // inside the render and take the whole candidate page down with it —
      // costing the hiring team the pipeline and the setup form over a panel
      // that had nothing to show in the first place.
      setPanel({
        assigned: Array.isArray(data?.assigned) ? data.assigned : [],
        reviews: Array.isArray(data?.reviews) ? data.reviews : [],
        awaiting: Array.isArray(data?.awaiting) ? data.awaiting : [],
      });
      setError('');
      setRefused(false);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) { setRefused(true); return; }
      setError(err instanceof Error ? err.message : 'Could not load the expert readings.');
    }
  }, [candidateId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!mayAssign) return;
    api.get<{ smes: Array<{ id: string; name: string; email: string }> }>(`/candidates/${candidateId}/sme/available`)
      .then((data) => setAvailable(Array.isArray(data?.smes) ? data.smes : []))
      // Not shown as an error: the panel's job is the readings, and being
      // unable to offer the picker does not stop anyone reading them.
      .catch(() => setAvailable([]));
  }, [candidateId, mayAssign]);

  const assign = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await api.post(`/candidates/${candidateId}/sme`, { userId: chosen });
      setChosen('');
      await load();
      toast.show('They can now see this candidate and record a recommendation.', { testId: 'sme-assigned' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not ask them to assess this candidate.');
    } finally {
      setBusy(false);
    }
  };

  const unassign = async (sme: AssignedSme) => {
    setBusy(true);
    try {
      await api.del(`/candidates/${candidateId}/sme/${sme.userId}`);
      await load();
      toast.show(`${sme.name} can no longer see this candidate.`, { testId: 'sme-unassigned' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not remove them.');
    } finally {
      setBusy(false);
    }
  };

  if (refused) return null;

  return (
    <div className="card" data-testid="sme-panel">
      <h2 className="card-title"><Icon name="human-review" />Expert readings</h2>

      {error && <Banner kind="error">{error}</Banner>}

      {/* Beside every recommendation, on every surface, from one constant. */}
      <p className="muted small">{SME_ADVISORY_NOTE}</p>

      {!panel ? (
        <p className="muted small">Loading…</p>
      ) : (
        <>
          {panel.reviews.length === 0 ? (
            <p className="muted small">No expert has recorded a reading of this candidate.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }}>
              {panel.reviews.map((review) => (
                <li key={review.id} style={{ marginBottom: 14 }}>
                  <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                    <strong>{review.recommendationLabel}</strong>
                    <span className="muted small">{review.sme.name} · {formatDateTime(review.updatedAt)}</span>
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{review.feedback}</div>
                </li>
              ))}
            </ul>
          )}

          {panel.awaiting.length > 0 && (
            <p className="muted small">{awaitingSummary(panel.awaiting)}</p>
          )}
        </>
      )}

      {mayAssign ? (
        <div style={{ marginTop: 14 }}>
          <label htmlFor="sme-assign">Ask an expert to assess this candidate</label>
          {available.length === 0 ? (
            <p className="field-hint">
              Nobody in your organisation has the subject-matter expert role yet. An admin invites one from People.
            </p>
          ) : (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select id="sme-assign" value={chosen} onChange={(e) => setChosen(e.target.value)}>
                <option value="">Choose someone…</option>
                {available
                  .filter((sme) => !panel?.assigned.some((a) => a.userId === sme.id))
                  .map((sme) => <option key={sme.id} value={sme.id}>{sme.name} · {sme.email}</option>)}
              </select>
              <button type="button" className="btn sm" disabled={!chosen || busy} onClick={() => void assign()}>
                {busy ? 'Please wait…' : 'Ask them'}
              </button>
            </div>
          )}
          {/* Said where the grant is made: this hands a named colleague the
              candidate's identity, which is not something to discover later. */}
          <p className="field-hint">They will see who this candidate is, their transcripts, and the approved scorecard. Nothing else.</p>

          {panel && panel.assigned.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, marginTop: 10 }}>
              {panel.assigned.map((sme) => (
                <li key={sme.userId} className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <span>{sme.name}</span>
                  <span className="muted small">asked {formatDateTime(sme.assignedAt)}</span>
                  <button
                    type="button" className="btn sm ghost" disabled={busy}
                    aria-label={`Stop asking ${sme.name} to assess this candidate`}
                    onClick={() => void unassign(sme)}
                  >
                    Stop asking
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="muted small" style={{ marginTop: 14 }}>{onlyWhoCan('sme:assign', 'ask an expert to assess a candidate')}</p>
      )}
    </div>
  );
}
