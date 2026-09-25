import { Icon } from './Icon';
import {
  formatOffset, groupQuotesByCompetency, orderedTranscript, quotesStatusSentence, readQuotes,
  type CandidateConsentView, type EntryGate, type ObservationView, type RoomBlockView, type RoomPhase,
} from './observerModel';

/**
 * The pieces of the AI-observer screens, kept free of state and requests so
 * they render the same in a test as in the browser. The pages wire them up
 * (pages/ObserverRoom.tsx, pages/ObserverConsent.tsx).
 *
 * THERE IS NO TILE FOR THE OBSERVER, here or anywhere the round is shown. The
 * AI is not a participant: it does not speak, it is not spoken to, and nothing
 * in the room is addressed to it. What it does is disclosed on the entry gate
 * everybody passes, and while the round runs a status line says whether it is
 * capturing. This follows the room's own rule (web/src/components/room/
 * roomAnnouncements.ts): the interviewer's tile carries no AI label and the AI
 * is never announced, because presenting the machine as somebody in the
 * conversation reads as artificial and is not true.
 */

/**
 * Whether the observer is capturing, said in words, with a live dot. Both the
 * interviewer and the candidate see this; nobody should have to infer it.
 */
export function ListeningIndicator({ listening }: { listening: boolean }) {
  return (
    <p className={`observer-live${listening ? ' is-live' : ''}`} role="status" aria-live="polite">
      <span className="observer-dot" aria-hidden="true" />
      {listening ? 'Observer is listening — this round is being transcribed' : 'Not capturing — nothing is being transcribed'}
    </p>
  );
}

/**
 * The entry gate: what is captured, and the only way into the room.
 *
 * It is not a "would you like an observer?" question, because that is not a
 * question anybody is being asked — every human round is recorded. It is the
 * disclosure, and agreeing to it is how a person joins.
 */
export function EntryGateCard({ gate, party, busy, onConsent, onDecline }: {
  gate: EntryGate;
  party: 'interviewer' | 'hr';
  busy: boolean;
  onConsent: () => void;
  onDecline: () => void;
}) {
  return (
    <section className="card observer-consent" aria-labelledby="observer-consent-title" data-testid="observer-entry-gate">
      <h2 id="observer-consent-title">This round is recorded</h2>
      <p>{gate.notice}</p>
      <p className="muted small">{gate.consequence}</p>
      <p className="muted small">
        {party === 'interviewer'
          ? 'The candidate reads the same notice on their own device and agrees there. Questor does not join your '
            + 'meeting: keep this page open on the device you are taking the call on.'
          : 'You are joining a round somebody else is conducting. Your voice is captured like everyone else\'s, '
            + 'which is why you are asked as well.'}
      </p>
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={onConsent} data-testid="observer-agree">
          <Icon name="check-circle" size={16} />I agree — join the round
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onDecline}>
          <Icon name="x-circle" size={16} />I would rather not be recorded
        </button>
      </div>
    </section>
  );
}

/**
 * A round that cannot go ahead, with what may be done about it.
 *
 * Always both halves. A refusal with no next step is the defect a QA sweep
 * found on an expired room link, and it is worse here: somebody has an
 * interview in the diary that will not happen.
 */
export function RoundBlockedCard({ block, title }: { block: RoomBlockView; title?: string }) {
  return (
    <section className="card observer-blocked" aria-labelledby="observer-blocked-title" data-testid="observer-blocked">
      <h2 id="observer-blocked-title">{title ?? 'This round cannot go ahead'}</h2>
      <p>{block.reason}</p>
      <ul className="observer-next-steps">
        {block.nextSteps.map((step) => <li key={step}>{step}</li>)}
      </ul>
    </section>
  );
}

export function CandidateLinkCard({ link, onCopy }: { link: string; onCopy?: () => void }) {
  return (
    <section className="card observer-link" aria-labelledby="observer-link-title">
      <h2 id="observer-link-title">Waiting for the candidate</h2>
      <p className="muted small">
        Paste this link into the meeting chat. The candidate reads what is captured and agrees or declines on their
        own device; the round starts once they have. This page updates when they answer.
      </p>
      <div className="row">
        <input readOnly value={link} aria-label="Candidate consent link" className="observer-link-input" />
        {onCopy && (
          <button type="button" className="btn secondary" onClick={onCopy}><Icon name="copy" size={16} />Copy link</button>
        )}
      </div>
    </section>
  );
}

/**
 * The controls while the round runs.
 *
 * There is no "start listening" button any more. Capture begins when the room
 * is entered, which nobody may do without having agreed, so a start button
 * would be a control over something already settled — and its absence is what
 * makes "nobody presses record" true rather than merely intended.
 *
 * Stopping stays. It ends the round's capture rather than making the round
 * unrecorded: the round then says it cannot produce the evidence an assessment
 * rests on, which is the honest consequence and is said in words above.
 */
export function ObserverRoomControls({
  phase, awaiting, busy, stopSentence, degradedMessage, onStop, onEnd,
}: {
  phase: RoomPhase;
  awaiting: readonly string[];
  busy: boolean;
  stopSentence: string;
  degradedMessage?: string;
  onStop: () => void;
  onEnd: () => void;
}) {
  const listening = phase === 'listening';
  return (
    <section className="card observer-controls" aria-label="Observer controls">
      <ListeningIndicator listening={listening} />
      {degradedMessage && <p className="observer-note" role="alert">{degradedMessage}</p>}
      {stopSentence && <p className="observer-note">{stopSentence}</p>}
      {phase === 'awaiting_others' && (
        <p className="muted small" data-testid="observer-awaiting">
          {awaiting.includes('candidate')
            ? 'Waiting for the candidate to read what is captured and agree. The round starts by itself when they do.'
            : 'Waiting for the person conducting this round to join.'}
        </p>
      )}
      <div className="row">
        {(listening || phase === 'awaiting_others') && (
          <button type="button" className="btn danger" disabled={busy} onClick={onStop}>
            <Icon name="stop" size={16} />Stop recording and end this round
          </button>
        )}
        {(listening || phase === 'stopped' || phase === 'awaiting_others') && (
          <button type="button" className="btn ghost" disabled={busy} onClick={onEnd}>
            <Icon name="check" size={16} />End round
          </button>
        )}
      </div>
    </section>
  );
}

function TranscriptList({ observation }: { observation: ObservationView }) {
  const segments = orderedTranscript(observation.transcript);
  if (segments.length === 0) return <p className="muted">Nothing was captured in this round.</p>;
  return (
    <ol className="observer-transcript">
      {segments.map((segment) => (
        <li key={segment.index} className={segment.kind === 'GAP' ? 'is-gap' : undefined}>
          <span className="observer-time">{formatOffset(segment.offsetMs)}</span>
          {segment.kind === 'GAP'
            ? <span className="muted">[Not captured{segment.durationMs > 0 ? ` for ${formatOffset(segment.durationMs)}` : ''}: transcription was unavailable]</span>
            : <span>{segment.text}</span>}
        </li>
      ))}
    </ol>
  );
}

function QuoteList({ observation }: { observation: ObservationView }) {
  const groups = groupQuotesByCompetency(readQuotes(observation.quotes.items));
  const sentence = quotesStatusSentence(observation.quotes.status, observation.quotes.note);
  return (
    <>
      {sentence && <p className="muted">{sentence}</p>}
      {groups.map((group) => (
        <section key={group.competencyId} className="observer-competency" aria-label={group.competencyName}>
          <h4>{group.competencyName}</h4>
          <ul>
            {group.quotes.map((quote) => (
              <li key={`${quote.segmentIndex}-${quote.quote}`}>
                <span className="observer-time">{formatOffset(quote.offsetMs)}</span>
                <q>{quote.quote}</q>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** The round detail: what was said, and the evidence quotes by competency. */
export function ObserverTranscript({ observation }: { observation: ObservationView }) {
  return (
    <div className="observer-record">
      <section className="card" aria-labelledby="observer-quotes-title">
        <h2 id="observer-quotes-title">Evidence quotes</h2>
        <p className="observer-framing"><Icon name="evidence" size={16} />{observation.quotes.framing}</p>
        <QuoteList observation={observation} />
      </section>
      <section className="card" aria-labelledby="observer-transcript-title">
        <h2 id="observer-transcript-title">
          Transcript{observation.readOnly && <span className="muted small"> · Read-only</span>}
        </h2>
        <p className="muted small">
          Transcribed from the devices in the room. Speakers are not separated.
          {observation.captureStatus === 'DEGRADED' && ' Some of the round could not be captured; the gaps are marked.'}
        </p>
        <TranscriptList observation={observation} />
      </section>
    </div>
  );
}

/** The candidate's page: agree, decline, or stop. */
export function CandidateObserverConsent({ view, busy, onConsent, onDecline, onStop }: {
  view: CandidateConsentView;
  busy: boolean;
  onConsent: () => void;
  onDecline: () => void;
  onStop: () => void;
}) {
  const heading = view.canConsent
    ? `Your ${view.stage} interview with ${view.organisation} is recorded`
    : view.status === 'DECLINED' ? 'This interview will not go ahead as booked'
      : view.status === 'STOPPED' ? 'Recording stopped'
        : view.status === 'ENDED' ? 'This interview has ended'
          : 'You are ready to join';
  return (
    <section className="card auth-card observer-candidate" aria-labelledby="observer-candidate-title">
      <h2 id="observer-candidate-title">{heading}</h2>
      <p>{view.notice}</p>
      {view.canConsent && <p className="muted small" data-testid="observer-consequence">{view.consequence}</p>}
      {(view.listening || view.canStop) && <ListeningIndicator listening={view.listening} />}
      {/* Said as a fact about the round, not a fault in the person. Declining
          to be recorded is a legitimate choice, and the copy here is the last
          thing the candidate reads after making it. */}
      {view.status === 'DECLINED' && (
        <p className="muted" data-testid="observer-candidate-declined">
          Nothing was captured. This round is not going ahead as booked; the hiring team has been told, and they will
          be in touch about what happens next.
        </p>
      )}
      {view.status === 'STOPPED' && (
        <p className="muted">Recording stopped, so this round cannot go ahead as booked. The hiring team has been told.</p>
      )}
      {view.status === 'CONSENTED' && (
        <p className="muted">
          {view.awaiting.includes('interviewer')
            ? 'Waiting for your interviewer to join. Recording starts when they do.'
            : 'Your interviewer is here. Recording has started.'}
        </p>
      )}
      <div className="row">
        {view.canConsent && (
          <button type="button" className="btn" disabled={busy} onClick={onConsent}>I agree — I am ready to join</button>
        )}
        {view.canDecline && (
          <button type="button" className="btn ghost" disabled={busy} onClick={onDecline}>I would rather not be recorded</button>
        )}
        {view.canStop && (
          <button type="button" className="btn danger" disabled={busy} onClick={onStop}>
            <Icon name="stop" size={16} />Stop recording
          </button>
        )}
      </div>
    </section>
  );
}
