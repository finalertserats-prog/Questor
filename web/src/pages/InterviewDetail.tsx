import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { recBadge, stateBadge, Banner } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';

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

export function InterviewDetail() {
  const { id } = useParams();
  const [data, setData] = useState<InterviewResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.get<InterviewResp>(`/interviews/${id}`)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { setLoading(true); load(); }, [id]);

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

  const doAction = async (fn: () => Promise<unknown>, ok?: string) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await fn();
      if (ok) setNotice(ok);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const invite = () => doAction(() => api.post(`/interviews/${id}/invite`, {}), 'Invitation created.');
  const resend = () => doAction(() => api.post(`/interviews/${id}/resend`, {}), 'Invitation email sent again.');
  const schedule = () => {
    if (!scheduleAt) return;
    doAction(() => api.post(`/interviews/${id}/schedule`, { scheduledAt: new Date(scheduleAt).toISOString() }), 'Interview scheduled.');
  };
  const cancel = () => doAction(() => api.post(`/interviews/${id}/cancel`, {}), 'Interview cancelled.');

  const copyUrl = () => {
    if (!invitation?.portalUrl) return;
    navigator.clipboard?.writeText(invitation.portalUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <PageHeader
        icon="interviews"
        title="Interview"
        badge={stateBadge(session.state)}
        actions={<button className="btn danger" onClick={cancel} disabled={busy}><Icon name="x-circle" size={16} />Cancel interview</button>}
      />

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
            Scheduled for {new Date(session.scheduledAt).toLocaleString()}
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
                    ? `opened ${new Date(invitation.openedAt).toLocaleString()}`
                    : `sent ${new Date(invitation.sentAt).toLocaleString()} — not opened yet`}
                </span>
              )}
            </div>
            {invitation.sentAt && !invitation.openedAt && (
              <div className="muted small" style={{ marginBottom: 8 }}>
                Delivered to the mail provider, but the candidate hasn’t opened the link.
                If it’s been a day, ask them to check their spam folder.
              </div>
            )}
            <label>Candidate portal link</label>
            <div className="row">
              <input readOnly value={invitation.portalUrl} style={{ flex: 1 }} />
              <button className="btn secondary" type="button" onClick={copyUrl}>
                <Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>Share this link with the candidate.</div>
            <div className="row" style={{ marginTop: 14, gap: 8 }}>
              <Link className="btn" to={`/room/${invitation.token}`}><Icon name="play" size={16} />Open interview room (recruiter preview)</Link>
              <button className="btn secondary" type="button" onClick={resend} disabled={busy}>
                <Icon name={busy ? 'hourglass' : 'send'} size={16} />{busy ? 'Sending…' : 'Resend email'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button className="btn" onClick={invite} disabled={busy}><Icon name="send" size={16} />Send invitation</button>
            <div className="muted small" style={{ marginTop: 8 }}>
              Send an invitation to generate the candidate portal link and enable the interview room.
            </div>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <label>Schedule</label>
          <div className="row">
            <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} style={{ flex: 1 }} />
            <button className="btn secondary" onClick={schedule} disabled={busy || !scheduleAt}><Icon name="schedule" size={16} />Save</button>
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
