import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Badge, Banner } from './ui';
import { Icon } from './Icon';
import { formatDateTime } from './dateFormat';
import { toneToBadgeKind } from './statusModel';
import { consentSummary, requestAction, sendAction, type FeedbackConsent } from './feedbackConsentModel';
import { useToast } from './Toast';

/**
 * Written feedback for the candidate: draft, approve, send — and whether the
 * candidate has agreed to receive it.
 *
 * The send button stays disabled, with the reason beside it, until the
 * candidate has said yes. For a candidate who was never asked, the panel
 * offers to email them the question instead.
 */

interface Feedback {
  status: 'DRAFT' | 'APPROVED' | 'SENT';
  draftText: string;
  approvedText: string | null;
  sentAt: string | null;
  candidateRequested: boolean;
}

interface FeedbackResp {
  feedback: Feedback | null;
  consent: FeedbackConsent;
}

type Busy = 'draft' | 'approve' | 'send' | 'request' | null;

const MIN_TEXT = 10;

export function CandidateFeedbackPanel({ assessmentId }: { assessmentId: string }) {
  const [data, setData] = useState<FeedbackResp | null>(null);
  // Hidden rather than shown as an error for someone who may not review.
  const [hidden, setHidden] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const d = await api.get<FeedbackResp>(`/assessments/${assessmentId}/feedback`);
      setData(d);
      setText(d.feedback?.approvedText ?? d.feedback?.draftText ?? '');
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) { setHidden(true); return; }
      setError(err instanceof Error ? err.message : 'Could not load the candidate feedback.');
    }
  }, [assessmentId]);

  useEffect(() => { void load(); }, [load]);

  const run = async (action: Exclude<Busy, null>, call: () => Promise<unknown>, done: string) => {
    setBusy(action);
    setError('');
    try {
      await call();
      await load();
      toast.show(done);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  if (hidden) return null;
  if (!data) {
    return error ? <div className="card"><Banner kind="error">{error}</Banner></div> : null;
  }

  const { feedback, consent } = data;
  const summary = consentSummary(consent);
  const send = sendAction({ consent, feedbackStatus: feedback?.status ?? null, busy: busy !== null });
  const ask = requestAction(consent);
  const sent = feedback?.status === 'SENT';
  const textReady = text.trim().length >= MIN_TEXT;

  return (
    <div className="card" data-testid="candidate-feedback">
      <h2 className="card-title"><Icon name="mail" />Written feedback for the candidate</h2>

      <p>
        <Badge kind={toneToBadgeKind(summary.tone)}>{summary.label}</Badge>{' '}
        <span className="muted small">{summary.detail}</span>
      </p>
      {ask.visible && (
        <p>
          <button
            type="button"
            className="btn secondary sm"
            disabled={busy !== null}
            onClick={() => void run(
              'request',
              () => api.post(`/assessments/${assessmentId}/feedback/opt-in-request`, {}),
              'The candidate has been emailed a link to say whether they would like feedback.',
            )}
          >
            <Icon name={busy === 'request' ? 'hourglass' : 'send'} size={15} />
            {busy === 'request' ? 'Sending…' : ask.label}
          </button>{' '}
          <span className="muted small">Emails them a yes/no question. Nothing is sent unless they say yes.</span>
        </p>
      )}
      {ask.note && <p className="muted small">{ask.note}</p>}

      {error && <Banner kind="error">{error}</Banner>}

      {sent ? (
        <>
          <p className="muted small">Sent {formatDateTime(feedback?.sentAt)}.</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{feedback?.approvedText}</p>
        </>
      ) : (
        <>
          <label htmlFor="feedback-text">
            {feedback?.status === 'APPROVED' ? 'Approved text (editing it returns it to draft)' : 'Draft'}
          </label>
          <textarea id="feedback-text" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn secondary"
              disabled={busy !== null || !textReady}
              onClick={() => void run('draft', () => api.post(`/assessments/${assessmentId}/feedback/draft`, { draftText: text }), 'Draft saved.')}
            >
              {busy === 'draft' ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy !== null || !textReady || feedback?.status !== 'DRAFT'}
              onClick={() => void run('approve', () => api.post(`/assessments/${assessmentId}/feedback/approve`, { approvedText: text }), 'Approved.')}
            >
              {busy === 'approve' ? 'Approving…' : 'Approve this text'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={send.disabled}
              aria-describedby={send.reason ? 'feedback-send-reason' : undefined}
              onClick={() => void run('send', () => api.post(`/assessments/${assessmentId}/feedback/send`, {}), 'Feedback sent.')}
            >
              <Icon name={busy === 'send' ? 'hourglass' : 'send'} size={16} />
              {busy === 'send' ? 'Sending…' : 'Send to candidate'}
            </button>
          </div>
          {send.reason && <p id="feedback-send-reason" className="muted small" style={{ marginTop: 6 }}>{send.reason}</p>}
        </>
      )}
    </div>
  );
}
