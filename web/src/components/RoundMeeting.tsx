import { useState } from 'react';
import { api } from '../api/client';
import { Icon } from './Icon';
import { meetingLinkProblem, meetingSummary, providerLabel, type MeetingOutcome, type RoundMeetingView } from './roundMeetingModel';

export interface RoundForMeeting {
  id: string;
  status: string;
  conductedBy: 'AI' | 'HUMAN';
  meeting?: RoundMeetingView | null;
}

type Run = (action: () => Promise<unknown>) => Promise<void>;
type Report = (outcome: MeetingOutcome | null) => void;

interface Props {
  pipelineId: string;
  round: RoundForMeeting;
  busy: boolean;
  run: Run;
  onOutcome: Report;
  onError: (message: string) => void;
  /** The organisation's current provider can create meetings. */
  vendorReady?: boolean;
}

const base = (pipelineId: string, roundId: string) => `/pipelines/${pipelineId}/rounds/${roundId}`;

/** A human round's meeting: its join link, what went wrong, and how to fix it. */
export function RoundMeeting({ pipelineId, round, busy, run, onOutcome, onError, vendorReady = false }: Props) {
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState('');

  if (round.conductedBy !== 'HUMAN') return <span className="muted small">Questor room</span>;
  if (!round.meeting) return <span className="muted small">—</span>;

  const summary = meetingSummary(round.meeting, round.status, vendorReady);

  const retry = () => run(() => api.post<{ meeting: MeetingOutcome }>(`${base(pipelineId, round.id)}/meeting/retry`, {})
    .then((resp) => onOutcome(resp.meeting)));

  const saveLink = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = meetingLinkProblem(link);
    if (problem) { onError(problem); return; }
    void run(() => api.put<{ meeting: MeetingOutcome }>(`${base(pipelineId, round.id)}/meeting-link`, { url: link.trim() })
      .then((resp) => { onOutcome(resp.meeting); setAdding(false); setLink(''); }));
  };

  return (
    <div className="round-meeting" data-testid={`round-meeting-${round.id}`}>
      <div className="small">
        <b>{providerLabel(round.meeting.provider)}</b>{' '}
        {summary.link && (
          <a href={summary.link} target="_blank" rel="noopener noreferrer"><Icon name="link" size={14} />Join meeting</a>
        )}
      </div>
      <div className={`small ${summary.tone === 'error' ? 'round-meeting-error' : 'muted'}`} role={summary.tone === 'error' ? 'alert' : undefined}>
        {summary.text}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 4 }}>
        {summary.canRetry && (
          <button type="button" className="btn sm secondary" disabled={busy} onClick={() => { void retry(); }}>
            {round.meeting.status === 'NEEDS_LINK' && !round.meeting.error ? 'Create meeting' : 'Try again'}
          </button>
        )}
        {summary.canAddLink && !adding && (
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setAdding(true)}>
            {round.meeting.status === 'MANUAL' ? 'Change link' : 'Add link manually'}
          </button>
        )}
      </div>
      {adding && (
        <form className="row" style={{ gap: 6, marginTop: 4 }} onSubmit={saveLink}>
          <label className="visually-hidden" htmlFor={`meeting-link-${round.id}`}>Meeting link</label>
          <input
            id={`meeting-link-${round.id}`}
            type="url"
            inputMode="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://…"
            required
          />
          <button className="btn sm" disabled={busy}>Save link</button>
          <button type="button" className="btn sm ghost" onClick={() => { setAdding(false); setLink(''); }}>Cancel</button>
        </form>
      )}
    </div>
  );
}

/** Move or cancel a scheduled round. Cancelling asks once more: it removes the meeting too. */
export function RoundActions(
  { pipelineId, round, busy, run, onOutcome, onError, canReschedule = true }: Props & { canReschedule?: boolean },
) {
  const [moving, setMoving] = useState(false);
  const [when, setWhen] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  // AI rounds are moved or cancelled with their interview session, not here.
  if (round.status !== 'SCHEDULED' || round.conductedBy !== 'HUMAN') return null;

  const reschedule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!when) return;
    if (new Date(when).getTime() < Date.now()) {
      onError('That time has already passed. Pick a date and time in the future.');
      return;
    }
    void run(() => api.post<{ meeting: MeetingOutcome | null }>(`${base(pipelineId, round.id)}/reschedule`, { scheduledAt: new Date(when).toISOString() })
      .then((resp) => { onOutcome(resp.meeting); setMoving(false); setWhen(''); }));
  };

  const cancel = () => run(() => api.post<{ meeting: MeetingOutcome | null }>(`${base(pipelineId, round.id)}/cancel`, {})
    .then((resp) => { onOutcome(resp.meeting); setConfirmCancel(false); }));

  if (moving) {
    return (
      <form className="row" style={{ gap: 6 }} onSubmit={reschedule}>
        <label className="visually-hidden" htmlFor={`reschedule-${round.id}`}>New date and time</label>
        <input id={`reschedule-${round.id}`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
        <button className="btn sm" disabled={busy}>Move</button>
        <button type="button" className="btn sm ghost" onClick={() => setMoving(false)}>Back</button>
      </form>
    );
  }

  if (confirmCancel) {
    return (
      <div className="small">
        Cancel this round{round.meeting?.status === 'LINKED' ? ` and remove its ${providerLabel(round.meeting.provider)} meeting` : ''}?
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <button type="button" className="btn sm" disabled={busy} onClick={() => { void cancel(); }}>Yes, cancel it</button>
          <button type="button" className="btn sm ghost" onClick={() => setConfirmCancel(false)}>Keep it</button>
        </div>
      </div>
    );
  }

  return (
    <div className="row" style={{ gap: 6 }}>
      {/* A decided pipeline's rounds can still be cancelled, not moved. */}
      {canReschedule && (
        <button type="button" className="btn sm secondary" disabled={busy} onClick={() => setMoving(true)}>
          <Icon name="schedule" size={14} />Reschedule
        </button>
      )}
      <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel round</button>
    </div>
  );
}
