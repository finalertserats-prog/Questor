import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import {
  ALREADY_ANSWERED, FEEDBACK_EXPLANATION, FEEDBACK_NO_LABEL, FEEDBACK_QUESTION, FEEDBACK_YES_LABEL, answerConfirmation,
} from '../components/feedbackOptInCopy';

/**
 * "Would you like written feedback?" — the page behind the link a recruiter's
 * request emails to a candidate who was never asked.
 *
 * Built like TalkToAPerson, for the same reasons: nothing is recorded on load
 * (mail scanners open every link), and nothing about the candidate is shown
 * (the link is a bearer credential sitting in a mailbox).
 */

type Phase = 'loading' | 'open' | 'recorded' | 'answered' | 'expired' | 'unknown' | 'failed';

export function FeedbackConsent() {
  const { token } = useParams();
  const [phase, setPhase] = useState<Phase>('loading');
  const [choice, setChoice] = useState<'YES' | 'NO'>('NO');
  const [submitting, setSubmitting] = useState(false);

  const failWith = (err: unknown) => {
    if (err instanceof ApiError && err.status === 410) setPhase('expired');
    else if (err instanceof ApiError && err.status === 404) setPhase('unknown');
    else setPhase('failed');
  };

  useEffect(() => {
    let cancelled = false;
    api.get<{ state: 'open' | 'answered' }>(`/feedback-consent/${token}`)
      .then((res) => { if (!cancelled) setPhase(res.state === 'answered' ? 'answered' : 'open'); })
      .catch((err: unknown) => { if (!cancelled) failWith(err); });
    return () => { cancelled = true; };
  }, [token]);

  const answer = useCallback(async (wantsFeedback: boolean) => {
    setSubmitting(true);
    try {
      const res = await api.post<{ state: 'recorded' | 'answered' }>(`/feedback-consent/${token}/answer`, { wantsFeedback });
      setChoice(wantsFeedback ? 'YES' : 'NO');
      // The server keeps the first answer. If one was already on file this
      // click changed nothing, and the page says so rather than confirming it.
      setPhase(res.state === 'recorded' ? 'recorded' : 'answered');
    } catch (err: unknown) {
      failWith(err);
    } finally {
      setSubmitting(false);
    }
  }, [token]);

  return (
    <div className="center-screen">
      <div className="card auth-card">
        {phase === 'loading' && <p className="muted">One moment…</p>}

        {phase === 'open' && (
          <>
            <h2>{FEEDBACK_QUESTION}</h2>
            <p className="muted">{FEEDBACK_EXPLANATION}</p>
            <div className="row">
              <button type="button" className="btn" disabled={submitting} onClick={() => void answer(true)}>
                {FEEDBACK_YES_LABEL}
              </button>
              <button type="button" className="btn secondary" disabled={submitting} onClick={() => void answer(false)}>
                {FEEDBACK_NO_LABEL}
              </button>
            </div>
          </>
        )}

        {phase === 'recorded' && (
          <>
            <h2>Thank you.</h2>
            <p className="muted">{answerConfirmation(choice)}</p>
          </>
        )}

        {phase === 'answered' && (
          <>
            <h2>You have already answered.</h2>
            <p className="muted">{ALREADY_ANSWERED}</p>
          </>
        )}

        {phase === 'expired' && (
          <>
            <h2>This link has expired.</h2>
            <p className="muted">
              These links work for 30 days. We will not send you feedback without your yes. If you would still
              like some, reply to the email this link came in.
            </p>
          </>
        )}

        {phase === 'unknown' && (
          <>
            <h2>This link doesn't work.</h2>
            <p className="muted">
              It may have been copied incompletely, or a newer email replaced it. Try the link in the most
              recent email from us, or reply to that email instead.
            </p>
          </>
        )}

        {phase === 'failed' && (
          <>
            <h2>Something went wrong at our end.</h2>
            <p className="muted">
              Your answer was not saved. Please try again in a moment, or reply to the email this link came in.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
