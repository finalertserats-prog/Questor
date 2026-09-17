import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { recBadge, stateBadge, Banner } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { isInFlight } from './CandidatesList';
import { formatDateTime } from '../components/dateFormat';

interface Block { competencyId: string; competencyName: string; intent: string; targetMinutes: number; module?: string; }
interface Turn { id: string; index: number; speaker: 'agent' | 'candidate' | 'system'; text: string; startMs: number; endMs: number; competencyId: string | null; }
interface Invitation { token: string; status: string; portalUrl: string; sentAt: string | null; openedAt: string | null; }
interface Session {
  id: string; state: string; provider: string; language: string; durationMinutes: number;
  scheduledAt: string | null; persona: { name: string; tone: string }; consent: unknown;
}
interface InterviewResp {
  session: Session;
  plan: { blocks: Block[] } | null;
  turns: Turn[];
  assessment: { id: string; recommendation: string; result: unknown } | null;
  invitation: Invitation | null;
}

/** The things this page can do, one at a time. */
type Action = 'invite' | 'resend' | 'schedule' | 'cancel';

export function InterviewDetail() {
  const { id } = useParams();
  const [data, setData] = useState<InterviewResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [busyAction, setBusyAction] = useState<Action | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Returns its promise: an action that re-enables its button before the fresh
  // data lands invites a second press against the state it just changed.
  // `cancelled` so a response for an interview the person has already left
  // cannot overwrite the one they are looking at.
  const cancelledRef = useRef(false);

  const load = () =>
    api.get<InterviewResp>(`/interviews/${id}`)
      .then((d) => { if (!cancelledRef.current) setData(d); })
      .catch((err: unknown) => {
        if (!cancelledRef.current) setError(err instanceof Error ? err.message : 'Could not load this interview.');
      })
      .finally(() => { if (!cancelledRef.current) setLoading(false); });

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    void load();
    return () => { cancelledRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) return <PageSkeleton label="Loading interview…" cards={3} />;
  if (error && !data) return <Banner kind="error">{error}</Banner>;
  if (!data) {
    return (
      <EmptyState
        icon="interviews"
        title="Interview not found"
        message="It may have been removed, or the link is out of date."
        action={<Link className="btn secondary" to="/interviews"><Icon name="arrow-left" size={16} />All interviews</Link>}
      />
    );
  }

  const { session, plan, turns, assessment, invitation } = data;

  // Which action is running, not merely that one is: a single flag put
  // "Sending…" on the resend button while the person had pressed Schedule.
  const doAction = async (action: Action, fn: () => Promise<unknown>, ok?: string) => {
    if (busyAction) return;
    setError('');
    setNotice('');
    setBusyAction(action);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That did not go through.');
    } finally {
      setBusyAction(null);
    }
  };

  const invite = () => doAction('invite', () => api.post(`/interviews/${id}/invite`, {}), 'Invitation created.');
  const resend = () => doAction('resend', () => api.post(`/interviews/${id}/resend`, {}), 'Invitation email sent again.');
  const schedule = () => {
    if (!scheduleAt) return;
    void doAction('schedule', () => api.post(`/interviews/${id}/schedule`, { scheduledAt: new Date(scheduleAt).toISOString() }), 'Interview scheduled.');
  };
  const cancel = () => {
    // Cancelling ends the interview for the candidate, and nothing here undoes
    // it — so it is asked for rather than taken from one press of a red button.
    if (!confirmCancel) { setConfirmCancel(true); return; }
    setConfirmCancel(false);
    void doAction('cancel', () => api.post(`/interviews/${id}/cancel`, {}), 'Interview cancelled.');
  };

  const copyUrl = async () => {
    if (!invitation?.portalUrl) return;
    try {
      // Awaited: "Copied!" over a clipboard that refused sends someone away with
      // an empty clipboard and a link they think they have.
      await navigator.clipboard.writeText(invitation.portalUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('We could not reach your clipboard — select the link above and copy it yourself.');
    }
  };

  return (
    <div>
      <PageHeader
        icon="interviews"
        title="Interview"
        badge={stateBadge(session.state)}
        actions={
          // Nothing to cancel once the interview has reached a state it will
          // not leave on its own — the same set the candidates list reads.
          isInFlight(session.state) ? (
            <button type="button" className="btn danger" onClick={cancel} disabled={busyAction !== null}>
              <Icon name="x-circle" size={16} />
              {busyAction === 'cancel' ? 'Cancelling…' : confirmCancel ? 'Confirm cancel' : 'Cancel interview'}
            </button>
          ) : undefined
        }
      />

      {confirmCancel && (
        <Banner kind="info">
          Cancelling ends this interview for the candidate and cannot be undone. Press
          "Confirm cancel" to go ahead, or{' '}
          <button type="button" className="btn ghost sm" onClick={() => setConfirmCancel(false)}>keep it</button>.
        </Banner>
      )}

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}
      {assessment && (
        <Banner kind="ok">
          <span className="row" style={{ display: 'inline-flex' }}>
            Assessment ready — {recBadge(assessment.recommendation)}
            <Link className="link-action" to={`/assessments/${assessment.id}`}><Icon name="evidence" size={15} />View assessment</Link>
          </span>
        </Banner>
      )}

      <div className="card">
        <div className="grid cols-4">
          <div><div className="muted small">Provider</div><b>{session.provider}</b></div>
          <div><div className="muted small">Duration</div><b>{session.durationMinutes} min</b></div>
          <div><div className="muted small">Language</div><b>{session.language}</b></div>
          <div><div className="muted small">Persona</div><b>{session.persona?.name} ({session.persona?.tone})</b></div>
        </div>
        {session.scheduledAt && (
          <div className="muted small" style={{ marginTop: 10 }}>
            Scheduled for {formatDateTime(session.scheduledAt)}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title"><Icon name="list" />Interview plan</h2>
        {plan && (plan.blocks ?? []).length > 0 ? (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Interview plan">
            <table>
              <thead><tr><th>Competency</th><th>Intent</th><th>Target</th></tr></thead>
              <tbody>
                {plan.blocks.map((b, i) => (
                  <tr key={i}>
                    <td>{b.competencyName}</td>
                    <td className="muted">{b.intent}</td>
                    <td>{b.targetMinutes} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState compact icon="list" title="No plan available" message="A plan is built from the role’s approved scorecard when the interview is created." />
        )}
      </div>

      <div className="card">
        <h2 className="card-title"><Icon name="mail" />Invitation</h2>
        {invitation ? (
          <div>
            {/* Delivery is reported in three distinct states, because "sent"
                alone told recruiters nothing useful: a mail provider accepting
                a message is not the same as a candidate seeing it. */}
            <div className="row" style={{ marginBottom: 6, gap: 8 }}>
              {(() => {
                const [kind, icon, text]: [string, IconName, string] = invitation.openedAt
                  ? ['green', 'eye', 'opened by candidate']
                  : invitation.sentAt ? ['blue', 'send', 'email sent'] : ['amber', 'mail', 'not sent'];
                return <span className={`badge ${kind} status-badge`}><Icon name={icon} size={13} />{text}</span>;
              })()}
              {invitation.sentAt && (
                <span className="muted small">
                  {invitation.openedAt
                    ? `opened ${formatDateTime(invitation.openedAt)}`
                    : `sent ${formatDateTime(invitation.sentAt)} — not opened yet`}
                </span>
              )}
            </div>
            {invitation.sentAt && !invitation.openedAt && (
              <div className="muted small" style={{ marginBottom: 8 }}>
                Delivered to the mail provider, but the candidate hasn’t opened the link.
                If it’s been a day, ask them to check their spam folder.
              </div>
            )}
            <label htmlFor="portal-link">Candidate portal link</label>
            <div className="row">
              <input id="portal-link" readOnly value={invitation.portalUrl} style={{ flex: 1 }} />
              <button className="btn secondary" type="button" onClick={() => void copyUrl()}>
                <Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>Share this link with the candidate.</div>
            <div className="row" style={{ marginTop: 14, gap: 8 }}>
              <Link className="btn" to={`/room/${invitation.token}`}><Icon name="play" size={16} />Open interview room (recruiter preview)</Link>
              <button className="btn secondary" type="button" onClick={resend} disabled={busyAction !== null}>
                <Icon name={busyAction === 'resend' ? 'hourglass' : 'send'} size={16} />
                {busyAction === 'resend' ? 'Sending…' : 'Resend email'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button type="button" className="btn" onClick={invite} disabled={busyAction !== null}>
              <Icon name={busyAction === 'invite' ? 'hourglass' : 'send'} size={16} />
              {busyAction === 'invite' ? 'Sending…' : 'Send invitation'}
            </button>
            <div className="muted small" style={{ marginTop: 8 }}>
              Send an invitation to generate the candidate portal link and enable the interview room.
            </div>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <label htmlFor="schedule-at">Schedule</label>
          <div className="row">
            <input id="schedule-at" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} style={{ flex: 1 }} />
            <button type="button" className="btn secondary" onClick={schedule} disabled={busyAction !== null || !scheduleAt}>
              <Icon name={busyAction === 'schedule' ? 'hourglass' : 'schedule'} size={16} />
              {busyAction === 'schedule' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title"><Icon name="interviews" />Transcript</h2>
        {(turns ?? []).length === 0 ? (
          <EmptyState compact icon="interviews" title="No transcript yet" message="The conversation appears here once the candidate starts the interview." />
        ) : (
          <div className="transcript">
            {turns.map((t) => (
              <div key={t.id} className={'turn ' + t.speaker}>
                <div className="who">{t.speaker}</div>
                <div className="bubble">{t.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
