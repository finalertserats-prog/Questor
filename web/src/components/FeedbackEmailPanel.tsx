import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { formatDateTime } from './dateFormat';
import { feedbackEmailSummary, type FeedbackEmailState } from './feedbackEmailModel';

/**
 * The candidate's automatic feedback email, on the assessment page: whether it
 * went and when, the exact text behind "View", and "Send feedback now" for a
 * completed interview whose feedback has not gone. The send asks first,
 * showing the email as the candidate will receive it.
 */

interface Preview { to: string; subject: string; text: string }

type Busy = 'preview' | 'send' | null;

export function FeedbackEmailPanel({ assessmentId }: { assessmentId: string }) {
  const [state, setState] = useState<FeedbackEmailState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setState(await api.get<FeedbackEmailState>(`/assessments/${assessmentId}/feedback-email`));
    } catch (err: unknown) {
      // Hidden rather than shown as an error for someone who may not read it.
      if (err instanceof ApiError && err.status === 403) { setHidden(true); return; }
      setError(err instanceof Error ? err.message : 'Could not load the feedback email.');
    }
  }, [assessmentId]);

  useEffect(() => { void load(); }, [load]);

  const askToSend = async () => {
    setBusy('preview');
    setError('');
    setNotice('');
    try {
      const r = await api.post<{ preview: Preview }>(`/assessments/${assessmentId}/feedback-email/preview`, {});
      setPreview(r.preview);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not prepare the email.');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const confirmSend = async () => {
    setBusy('send');
    setError('');
    try {
      const next = await api.post<FeedbackEmailState>(`/assessments/${assessmentId}/feedback-email/send`, {});
      setState(next);
      setPreview(null);
      if (next.email?.status === 'SENT') setNotice('Feedback sent to the candidate.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'The feedback email could not be sent.');
      setPreview(null);
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (hidden) return null;
  if (!state) return error ? <div className="card"><Banner kind="error">{error}</Banner></div> : null;

  const summary = feedbackEmailSummary(state, formatDateTime);
  const email = state.email;

  return (
    <div className="card" data-testid="feedback-email">
      <h2 className="card-title"><Icon name="mail" />Feedback email to the candidate</h2>
      <p data-testid="feedback-email-status" style={{ marginBottom: 4 }}><strong>{summary.headline}</strong></p>
      {summary.detail && <p className="muted small">{summary.detail}</p>}

      {summary.showText && email && (
        <details style={{ marginTop: 8 }}>
          <summary>View</summary>
          <p className="muted small" style={{ marginTop: 8 }}>Subject: {email.subject}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{email.bodyText}</p>
        </details>
      )}

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}

      {preview ? (
        <div role="dialog" aria-labelledby="feedback-email-confirm-title" className="card" style={{ marginTop: 12 }}>
          <h3 id="feedback-email-confirm-title" style={{ marginTop: 0 }}>Send this email to {preview.to}?</h3>
          <p className="muted small">Subject: {preview.subject}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{preview.text}</p>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={() => void confirmSend()} disabled={busy !== null}>
              <Icon name={busy === 'send' ? 'hourglass' : 'send'} size={16} />
              {busy === 'send' ? 'Sending…' : 'Send it'}
            </button>
            <button type="button" className="btn secondary" onClick={() => setPreview(null)} disabled={busy !== null}>Cancel</button>
          </div>
        </div>
      ) : summary.canSendNow && (
        <button type="button" className="btn secondary" style={{ marginTop: 8 }} onClick={() => void askToSend()} disabled={busy !== null}>
          <Icon name={busy === 'preview' ? 'hourglass' : 'send'} size={16} />
          {busy === 'preview' ? 'Preparing…' : 'Send feedback now'}
        </button>
      )}
    </div>
  );
}
