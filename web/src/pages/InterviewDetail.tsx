import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { accommodationRequestOf, interviewActions, MIN_REASON_LENGTH, type StateActions } from '../components/interviewActionsModel';
import { recBadge, stateBadge, Banner } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { formatDateTime, formatScheduled } from '../components/dateFormat';
import { EMPTY_SCHEDULE, TimeZoneDateTimePicker, isSchedulable } from '../components/TimeZoneDateTimePicker';
import { scheduleRequest, type ScheduleDraft } from '../components/zonedScheduleModel';
import { useOrgTimeZone } from '../components/useOrgTimeZone';
import { humanise } from '../components/statusModel';
import { isCurrentResponse, type LoadTicket } from '../components/roleDetailModel';
import { invitationPanel } from '../components/invitationPanelModel';

interface Block { competencyId: string; competencyName: string; intent: string; targetMinutes: number; module?: string; }
interface Turn {
  id: string; index: number; speaker: 'agent' | 'candidate' | 'system'; text: string; startMs: number; endMs: number; competencyId: string | null;
  /** Set when the turn is the candidate pressing Leave rather than anything they said. */
  source?: 'leave_button';
}
// No token: the server never returns one (links are sealed), only the portal link.
interface Invitation { status: string; portalUrl: string; sentAt: string | null; openedAt: string | null; }
interface Session {
  id: string; state: string; provider: string; language: string; durationMinutes: number;
  scheduledAt: string | null;
  /** The zone the time was booked in; null or absent when booked without one. */
  scheduledTimeZone?: string | null;
  /** Absent on an older server. */
  startedAt?: string | null; completedAt?: string | null;
  persona: { name?: string | null; tone?: string; interviewerId?: string }; consent: unknown;
}
interface InterviewResp {
  session: Session;
  plan: { blocks: Block[] } | null;
  /** The role's scorecard was approved again after this plan was built; the interview re-plans at start. */
  replanPending?: boolean;
  turns: Turn[];
  assessment: { id: string; recommendation: string; result: unknown } | null;
  invitation: Invitation | null;
  /** Who and what the interview is for. Optional: older servers do not send them. */
  candidate?: { id: string; name: string } | null;
  role?: { id: string; title: string } | null;
  /** What this interview's state allows. Absent on an older server. */
  actions?: StateActions;
}

/** The things this page can do, one at a time. */
type Action = 'invite' | 'resend' | 'schedule' | 'schedule-send' | 'cancel' | 'retake' | 'assess-partial' | 'reopen';

/** What the recovery card says, by state. */
const RECOVERY_HINTS: Record<string, string> = {
  MANUAL_HANDOFF: 'The candidate asked for an accommodation. Once it is arranged, reopen the interview and they carry on from where they stopped.',
  INCOMPLETE: 'The interview stopped part-way. Offer a retake on a new link, or assess what was said if it is enough to judge fairly.',
  TECHNICAL_FAILURE: 'The interview failed for a technical reason. Offer a retake on a new link.',
};

/** What POST /interviews/:id/schedule says about a send it was asked for. */
interface ScheduleResp { delivery?: { sent: boolean; note: string } }

export function InterviewDetail() {
  const { id } = useParams();
  const [data, setData] = useState<InterviewResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft>(EMPTY_SCHEDULE);
  const orgZone = useOrgTimeZone();
  const [busyAction, setBusyAction] = useState<Action | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState('');
  const { user } = useAuth();
  const navigate = useNavigate();

  // Returns its promise: an action that re-enables its button before the fresh
  // data lands invites a second press against the state it just changed.
  // Each load takes a ticket; only the newest one for the interview still on
  // screen may write, so a slow response for the previous interview (or an
  // older reload of this one) cannot overwrite the one being looked at.
  const latestLoad = useRef<LoadTicket>({ id: undefined, seq: 0 });

  const load = () => {
    const ticket: LoadTicket = { id, seq: latestLoad.current.seq + 1 };
    latestLoad.current = ticket;
    return api.get<InterviewResp>(`/interviews/${id}`)
      .then((d) => { if (isCurrentResponse(ticket, latestLoad.current)) setData(d); })
      .catch((err: unknown) => {
        if (isCurrentResponse(ticket, latestLoad.current)) setError(err instanceof Error ? err.message : 'Could not load this interview.');
      })
      .finally(() => { if (isCurrentResponse(ticket, latestLoad.current)) setLoading(false); });
  };

  useEffect(() => {
    // A different interview: drop everything shown for the previous one.
    setData(null);
    setError('');
    setNotice('');
    setDraft((current) => ({ ...EMPTY_SCHEDULE, timeZone: current.timeZone }));
    setConfirmCancel(false);
    setReason('');
    setLoading(true);
    void load();
    return () => { latestLoad.current = { id: undefined, seq: latestLoad.current.seq + 1 }; };
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
  const invitationView = invitation
    ? invitationPanel({
      state: session.state, startedAt: session.startedAt ?? null, completedAt: session.completedAt ?? null,
      sentAt: invitation.sentAt, openedAt: invitation.openedAt, assessmentId: assessment?.id ?? null,
    }, formatDateTime)
    : null;
  const acts = interviewActions(session.state, data.actions, user);
  const accommodation = accommodationRequestOf(session.consent);
  const reasonReady = reason.trim().length >= MIN_REASON_LENGTH;

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
  // The date, time and zone go to the server as picked; it converts, so the
  // time never passes through this browser's clock.
  const schedule = (send: boolean) => {
    if (!isSchedulable(draft)) return;
    void doAction(send ? 'schedule-send' : 'schedule', async () => {
      const resp = await api.post<ScheduleResp>(`/interviews/${id}/schedule`, { ...scheduleRequest(draft), send });
      setDraft((current) => ({ ...EMPTY_SCHEDULE, timeZone: current.timeZone }));
      if (resp.delivery && !resp.delivery.sent) setError(resp.delivery.note);
      else setNotice(resp.delivery ? `Schedule saved. ${resp.delivery.note}` : 'Schedule saved. Nothing was sent.');
    });
  };
  const cancel = () => {
    // Cancelling ends the interview for the candidate, and nothing here undoes
    // it — so it is asked for rather than taken from one press of a red button.
    if (!confirmCancel) { setConfirmCancel(true); return; }
    setConfirmCancel(false);
    void doAction('cancel', () => api.post(`/interviews/${id}/cancel`, {}), 'Interview cancelled.');
  };
  // Each is recorded with its reason. A retake is a new interview, and a
  // partial assessment is read on the assessment page, so both go there.
  const retake = () => void doAction('retake', async () => {
    const resp = await api.post<{ session: { id: string } }>(`/interviews/${id}/retake`, { reason: reason.trim() });
    setReason('');
    navigate(`/interviews/${resp.session.id}`);
  });
  const assessPartial = () => void doAction('assess-partial', async () => {
    const resp = await api.post<{ assessmentId: string }>(`/interviews/${id}/assess-partial`, { reason: reason.trim() });
    setReason('');
    navigate(`/assessments/${resp.assessmentId}`);
  });
  const reopen = () => void doAction('reopen', async () => {
    await api.post(`/interviews/${id}/reopen`, { reason: reason.trim() });
    setReason('');
  }, 'Interview reopened. Let the candidate know their link works again.');

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
        title={data.candidate?.name && data.role?.title ? `${data.candidate.name} · ${data.role.title}` : data.candidate?.name ?? 'Interview'}
        subtitle={data.candidate?.name ? 'Interview' : undefined}
        badge={stateBadge(session.state)}
        actions={
          <>
            {data.candidate && (
              <Link className="btn secondary" to={`/candidates/${data.candidate.id}`} data-testid="back-to-candidate">
                <Icon name="arrow-left" size={16} />Back to candidate
              </Link>
            )}
            {/* Only where the state machine lets the interview be cancelled:
                elsewhere the server refuses, and a started interview is ended
                by the candidate or the engine, not from here. */}
            {acts.cancel && (
              <button type="button" className="btn danger" onClick={cancel} disabled={busyAction !== null}>
                <Icon name="x-circle" size={16} />
                {busyAction === 'cancel' ? 'Cancelling…' : confirmCancel ? 'Confirm cancel' : 'Cancel interview'}
              </button>
            )}
          </>
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

      {accommodation && (
        <div className="card" data-testid="accommodation-request">
          <h2 className="card-title"><Icon name="handoff" />Accommodation request</h2>
          <p className="muted small" style={{ margin: '0 0 8px' }}>
            [ from the candidate{accommodation.requestedAt ? `, ${formatDateTime(accommodation.requestedAt)}` : ''} ]
          </p>
          <blockquote style={{ margin: 0, paddingLeft: 12, borderLeft: '2px solid var(--rule-strong)', whiteSpace: 'pre-wrap' }}>{accommodation.text}</blockquote>
        </div>
      )}

      {(acts.retake || acts.assessPartial || acts.reopen) && (
        <div className="card" data-testid="interview-recovery">
          <h2 className="card-title"><Icon name="refresh" />Next step</h2>
          {RECOVERY_HINTS[session.state] && <p className="muted small" style={{ marginTop: 0 }}>{RECOVERY_HINTS[session.state]}</p>}
          <label htmlFor="recovery-reason">Reason (kept in the audit trail)</label>
          <textarea id="recovery-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busyAction !== null} />
          {!reasonReady && <div className="muted small">At least {MIN_REASON_LENGTH} characters.</div>}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            {acts.reopen && (
              <button type="button" className="btn" onClick={reopen} disabled={busyAction !== null || !reasonReady}>
                <Icon name={busyAction === 'reopen' ? 'hourglass' : 'refresh'} size={16} />
                {busyAction === 'reopen' ? 'Reopening…' : 'Reopen interview'}
              </button>
            )}
            {acts.retake && (
              <button type="button" className="btn" onClick={retake} disabled={busyAction !== null || !reasonReady}>
                <Icon name={busyAction === 'retake' ? 'hourglass' : 'refresh'} size={16} />
                {busyAction === 'retake' ? 'Setting up…' : 'Offer a retake'}
              </button>
            )}
            {acts.assessPartial && (
              <button type="button" className="btn secondary" onClick={assessPartial} disabled={busyAction !== null || !reasonReady}>
                <Icon name={busyAction === 'assess-partial' ? 'hourglass' : 'evidence'} size={16} />
                {busyAction === 'assess-partial' ? 'Assessing…' : 'Assess the partial transcript'}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="grid cols-4">
          <div><div className="muted small">Provider</div><b>{humanise(session.provider)}</b></div>
          <div><div className="muted small">Duration</div><b>{session.durationMinutes} min</b></div>
          <div><div className="muted small">Language</div><b>{session.language}</b></div>
          {/* Two separate settings: who interviews (name and voice) and the tone. */}
          <div><div className="muted small">AI interviewer</div><b>{session.persona?.name ?? 'Not recorded'}{session.persona?.tone ? ` (${session.persona.tone.toLowerCase()} tone)` : ''}</b></div>
        </div>
        {session.scheduledAt && (
          <div className="muted small" style={{ marginTop: 10 }}>
            Scheduled for {formatScheduled(session.scheduledAt, session.scheduledTimeZone, orgZone)}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title"><Icon name="list" />Interview plan</h2>
        {data.replanPending && (
          <p className="muted small" data-testid="replan-pending">
            [ will be re-planned ] The role's competencies were approved again after this plan was built. When the
            interview starts it is planned from the current scorecard, and assessed against it.
          </p>
        )}
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
        {invitation && invitationView?.kind === 'status' ? (
          // Once the candidate has started, the link has done its job: the
          // card says what happened rather than offering a resend the server
          // refuses (see invitationPanelModel.ts).
          <div data-testid="invitation-status">
            <p style={{ margin: '0 0 8px' }}>{invitationView.text}</p>
            {invitationView.assessmentId && (
              <Link className="btn secondary" to={`/assessments/${invitationView.assessmentId}`}>
                <Icon name="evidence" size={16} />Open the assessment
              </Link>
            )}
          </div>
        ) : invitation ? (
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
            {invitationView?.kind === 'not-started' && invitationView.showNotOpenedHint && (
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
            {/* No recruiter preview here: the link is the candidate's own, and
                opening it would mark it opened for them. */}
            {/* Resend only before the interview starts; an interview waiting for
                a new date gets a fresh link instead (the server allows no other). */}
            {(acts.resend || acts.sendInvitation) && (
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                {acts.resend && (
                  <button className="btn secondary" type="button" onClick={resend} disabled={busyAction !== null}>
                    <Icon name={busyAction === 'resend' ? 'hourglass' : 'send'} size={16} />
                    {busyAction === 'resend' ? 'Sending…' : 'Resend email'}
                  </button>
                )}
                {acts.sendInvitation && !acts.resend && (
                  <button className="btn secondary" type="button" onClick={invite} disabled={busyAction !== null}>
                    <Icon name={busyAction === 'invite' ? 'hourglass' : 'send'} size={16} />
                    {busyAction === 'invite' ? 'Sending…' : 'Send a new invitation'}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : !acts.sendInvitation ? (
          <p className="muted small" style={{ margin: 0 }}>No invitation has been sent yet.</p>
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

        {/* Only while a time can still mean something: before the interview,
            or to book a missed one again. Elsewhere the server refuses. */}
        {acts.schedule && (
        <div role="group" aria-labelledby="schedule-title" style={{ marginTop: 16 }}>
          <h3 id="schedule-title" className="card-title"><Icon name="schedule" size={16} />Schedule</h3>
          {session.state === 'NO_SHOW' && (
            <p className="muted small" style={{ margin: '0 0 8px' }} data-testid="rebook-note">
              The candidate missed this interview. A new time books it again; sending emails them a fresh link.
            </p>
          )}
          {session.scheduledAt && (
            <p className="muted small" style={{ margin: '0 0 8px' }} data-testid="scheduled-now">
              Now: {formatScheduled(session.scheduledAt, session.scheduledTimeZone, orgZone)}
            </p>
          )}
          <TimeZoneDateTimePicker idPrefix="schedule" value={draft} onChange={setDraft} orgZone={orgZone} disabled={busyAction !== null} />
          <div className="row" style={{ gap: 8 }}>
            {acts.invite && (
              <button type="button" className="btn" onClick={() => schedule(true)} disabled={busyAction !== null || !isSchedulable(draft)}>
                <Icon name={busyAction === 'schedule-send' ? 'hourglass' : 'send'} size={16} />
                {busyAction === 'schedule-send' ? 'Saving and sending…' : 'Save schedule and send'}
              </button>
            )}
            <button type="button" className="btn secondary" onClick={() => schedule(false)} disabled={busyAction !== null || !isSchedulable(draft)}>
              <Icon name={busyAction === 'schedule' ? 'hourglass' : 'schedule'} size={16} />
              {busyAction === 'schedule' ? 'Saving…' : 'Save only'}
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>
            {invitation ? 'Sending emails the candidate again with the new time.' : 'Sending creates the invitation and emails it with this time.'}
          </p>
        </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title"><Icon name="interviews" />Transcript</h2>
        {(turns ?? []).length === 0 ? (
          <EmptyState compact icon="interviews" title="No transcript yet" message="The conversation appears here once the candidate starts the interview." />
        ) : (
          <div className="transcript">
            {turns.map((t) => (
              <div key={t.id} className={'turn ' + t.speaker}>
                <div className="who">{t.speaker}{t.source === 'leave_button' && ' · Candidate chose to leave'}</div>
                <div className="bubble">{t.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
