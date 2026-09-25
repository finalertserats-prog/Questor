import { useState } from 'react';
import { api } from '../../api/client';
import { Banner } from '../ui';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import {
  smeReviewProblem, SME_ADVISORY_NOTE, SME_FEEDBACK_MAX, SME_RECOMMENDATIONS, smeRecommendationLabel,
} from '../smeModel';

export interface ExistingReview {
  recommendation: string;
  feedback: string;
  sessionId: string | null;
  updatedAt: string;
}

/**
 * Where a subject-matter expert records what they made of a candidate.
 *
 * Two words and an argument. The words are deliberately not the reviewer's
 * three (Proceed / Consider / Do not progress): those are a verdict the
 * pipeline acts on, and these are advice a person weighs. Offering the same
 * vocabulary in both places would be the first step towards the two being
 * treated as the same thing.
 *
 * The advisory sentence sits above the buttons rather than under them, so it is
 * read before the choice is made rather than after.
 */
export function SmeReviewForm({
  candidateId, sessionId, existing, onSaved,
}: {
  candidateId: string;
  /** The interview this recommendation is about, when there is one. */
  sessionId: string | null;
  existing: ExistingReview | null;
  onSaved: (review: ExistingReview) => void;
}) {
  const toast = useToast();
  const [recommendation, setRecommendation] = useState(existing?.recommendation ?? '');
  const [feedback, setFeedback] = useState(existing?.feedback ?? '');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Checked here as well as on the server, so a missing argument is caught
    // while the person still has it in front of them rather than after a round
    // trip that loses nothing but reads as a fault.
    const bad = smeReviewProblem(recommendation, feedback);
    if (bad) { setProblem(bad); return; }
    setProblem('');
    setBusy(true);
    try {
      const saved = await api.put<{ review: ExistingReview }>(`/sme/candidates/${candidateId}/review`, {
        recommendation, feedback: feedback.trim(), sessionId,
      });
      onSaved(saved.review);
      toast.show(existing ? 'Your recommendation has been updated.' : 'Your recommendation has been recorded.', { testId: 'sme-review-saved' });
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : 'Could not record your recommendation.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title"><Icon name="human-review" />Your recommendation</h2>

      {/* Above the choice, not below it. */}
      <p className="muted small">{SME_ADVISORY_NOTE}</p>

      {problem && <Banner kind="error">{problem}</Banner>}

      <form onSubmit={submit} noValidate>
        <fieldset style={{ border: 0, padding: 0, margin: '8px 0 0' }}>
          <legend className="field-label">Would you proceed with this candidate?</legend>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {SME_RECOMMENDATIONS.map((value) => (
              <label key={value} className="row" style={{ gap: 6, alignItems: 'center' }} htmlFor={`sme-rec-${value}`}>
                <input
                  id={`sme-rec-${value}`}
                  type="radio"
                  name="sme-recommendation"
                  value={value}
                  checked={recommendation === value}
                  onChange={() => setRecommendation(value)}
                />
                {smeRecommendationLabel(value)}
              </label>
            ))}
          </div>
        </fieldset>

        <label htmlFor="sme-feedback">Why</label>
        {/* The reasoning is the part the hiring team cannot get anywhere else:
            they can already see a score. What they cannot see is why a person
            read the same candidate differently. */}
        <p className="field-hint" id="sme-feedback-hint">
          What you saw, and what it tells you about this role. This is the part the hiring team cannot get from the assessment.
        </p>
        <textarea
          id="sme-feedback"
          rows={7}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          aria-describedby="sme-feedback-hint"
          maxLength={SME_FEEDBACK_MAX}
        />

        <div className="row" style={{ gap: 10, marginTop: 14, alignItems: 'center' }}>
          <button className="btn" disabled={busy} data-testid="sme-review-submit">
            {busy ? 'Saving…' : existing ? 'Update recommendation' : 'Record recommendation'}
          </button>
          {existing && (
            // Stated plainly, because a second submit replaces the first rather
            // than adding to it, and an expert changing their mind should know
            // the earlier one does not stay on the page beside it.
            <span className="muted small">This replaces what you recorded before.</span>
          )}
        </div>
      </form>
    </div>
  );
}
