import { useState } from 'react';
import { api } from '../api/client';
import { Icon } from './Icon';
import { meetingLinkProblem, meetingSummary, providerLabel, type CandidateNotice, type MeetingOutcome, type RoundMeetingView } from './roundMeetingModel';
import { EMPTY_SCHEDULE, TimeZoneDateTimePicker } from './TimeZoneDateTimePicker';
import { browserTimeZone, schedulePreview, scheduleRequest, type ScheduleDraft } from './zonedScheduleModel';

export interface RoundForMeeting {
  id: string;
  status: string;
  conductedBy: 'AI' | 'HUMAN';
  meeting?: RoundMeetingView | null;
}

type Run = (action: () => Promise<unknown>) => Promise<void>;
/** The meeting's outcome, and whether the candidate was emailed about the change. */
type Report = (outcome: MeetingOutcome | null, candidate?: CandidateNotice | null) => void;
type RoundResponse = { meeting: MeetingOutcome | null; candidateNotice?: CandidateNotice };

interface Props {
  pipelineId: string;
  round: RoundForMeeting;
  busy: boolean;
  run: Run;
  onOutcome: Report;
  onError: (message: string) => void;
  /** The organisation's current provider can create meetings. */
  vendorReady?: boolean;
  /** The viewer cannot schedule: the meeting is shown, its fixes are not (the server would refuse them). */
  readOnly?: boolean;
}

const base = (pipelineId: string, roundId: string) => `/pipelines/${pipelineId}/rounds/${roundId}`;

/** A human round's meeting: its join link, what went wrong, and how to fix it. */
export function RoundMeeting({ pipelineId, round, busy, run, onOutcome, onError, vendorReady = false, readOnly = false }: Props) {
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState('');

  if (round.conductedBy !== 'HUMAN') return <span className="muted small">Questor room</span>;
  if (!round.meeting) return <span className="muted small">—</span>;

  const summary = meetingSummary(round.meeting, round.status, vendorReady);

  const retry = () => run(() => api.post<RoundResponse>(`${base(pipelineId, round.id)}/meeting/retry`, {})
    .then((resp) => onOutcome(resp.meeting, resp.candidateNotice ?? null)));

  const saveLink = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = meetingLinkProblem(link);
    if (problem) { onError(problem); return; }
    void run(() => api.put<RoundResponse>(`${base(pipelineId, round.id)}/meeting-link`, { url: link.trim() })
      .then((resp) => { onOutcome(resp.meeting, resp.candidateNotice ?? null); setAdding(false); setLink(''); }));
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
      {!readOnly && (
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
      )}
      {!readOnly && adding && (
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
  { pipelineId, round, busy, run, onOutcome, onError, canReschedule = true, orgZone }:
  Props & { canReschedule?: boolean; orgZone: string | null | undefined },
) {
  const [moving, setMoving] = useState(false);
  const [when, setWhen] = useState<ScheduleDraft>(EMPTY_SCHEDULE);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // AI rounds are moved or cancelled with their interview session, not here.
  if (round.status !== 'SCHEDULED' || round.conductedBy !== 'HUMAN') return null;

  const reschedule = (e: React.FormEvent) => {
    e.preventDefault();
    const preview = schedulePreview(when, new Date(), browserTimeZone());
    if (preview.kind !== 'ok') {
      onError(preview.kind === 'problem' ? preview.text : 'Pick the time zone, then the date and time.');
      return;
    }
    void run(() => api.post<RoundResponse>(`${base(pipelineId, round.id)}/reschedule`, scheduleRequest(when))
      .then((resp) => { onOutcome(resp.meeting, resp.candidateNotice ?? null); setMoving(false); setWhen((draft) => ({ ...EMPTY_SCHEDULE, timeZone: draft.timeZone })); }));
  };

  const cancel = () => run(() => api.post<{ meeting: MeetingOutcome | null }>(`${base(pipelineId, round.id)}/cancel`, {})
    .then((resp) => { onOutcome(resp.meeting); setConfirmCancel(false); }));

  if (moving) {
    return (
      <form onSubmit={reschedule} aria-label="Move this round">
        <TimeZoneDateTimePicker idPrefix={`reschedule-${round.id}`} value={when} onChange={setWhen} orgZone={orgZone} disabled={busy} compact />
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" disabled={busy}>Move</button>
          <button type="button" className="btn sm ghost" onClick={() => setMoving(false)}>Back</button>
        </div>
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
