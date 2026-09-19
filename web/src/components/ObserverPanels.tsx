import { Icon } from './Icon';
import {
  formatOffset, groupQuotesByCompetency, orderedTranscript, quotesStatusSentence, readQuotes,
  type CandidateConsentView, type ObservationView, type RoomPhase,
} from './observerModel';

/**
 * The pieces of the AI-observer screens, kept free of state and requests so
 * they render the same in a test as in the browser. The pages wire them up
 * (pages/ObserverRoom.tsx, pages/ObserverConsent.tsx).
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

export function InterviewerConsentCard({ notice, busy, onConsent, onDecline }: {
  notice: string;
  busy: boolean;
  onConsent: () => void;
  onDecline: () => void;
}) {
  return (
    <section className="card observer-consent" aria-labelledby="observer-consent-title">
      <h2 id="observer-consent-title">Use the AI observer for this round?</h2>
      <p>{notice}</p>
      <p className="muted small">
        The candidate is asked separately, on their own device. Nothing is captured until you have both agreed.
        Questor does not join your meeting: keep this page open on the device you are taking the call on.
      </p>
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={onConsent}>
          <Icon name="check-circle" size={16} />I agree — ask the candidate
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onDecline}>
          <Icon name="x-circle" size={16} />No observer for this round
        </button>
      </div>
    </section>
  );
}

export function CandidateLinkCard({ link, onCopy }: { link: string; onCopy?: () => void }) {
  return (
    <section className="card observer-link" aria-labelledby="observer-link-title">
      <h2 id="observer-link-title">Waiting for the candidate</h2>
      <p className="muted small">
        Paste this link into the meeting chat. The candidate reads what the observer does and agrees or declines on
        their own device. This page updates when they answer.
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

export function ObserverRoomControls({
  phase, isInterviewer, busy, stopSentence, degradedMessage, onStart, onStop, onEnd,
}: {
  phase: RoomPhase;
  isInterviewer: boolean;
  busy: boolean;
  stopSentence: string;
  degradedMessage?: string;
  onStart: () => void;
  onStop: () => void;
  onEnd: () => void;
}) {
  const listening = phase === 'listening';
  return (
    <section className="card observer-controls" aria-label="Observer controls">
      <ListeningIndicator listening={listening} />
      {degradedMessage && <p className="observer-note" role="alert">{degradedMessage}</p>}
      {stopSentence && <p className="observer-note">{stopSentence}</p>}
      {phase === 'ready' && !isInterviewer && (
        <p className="muted small">Only the interviewer who agreed can start the observer, on their own device.</p>
      )}
      <div className="row">
        {phase === 'ready' && (
          <button type="button" className="btn" disabled={busy || !isInterviewer} onClick={onStart}>
            <Icon name="mic" size={16} />Start listening
          </button>
        )}
        {(listening || phase === 'ready' || phase === 'awaiting_candidate') && (
          <button type="button" className="btn danger" disabled={busy} onClick={onStop}>
            <Icon name="stop" size={16} />Stop the observer
          </button>
        )}
        {(listening || phase === 'stopped' || phase === 'ready' || phase === 'awaiting_candidate') && (
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
          Transcribed from the interviewer&rsquo;s device. Speakers are not separated.
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
    ? `${view.organisation} would like to use an AI observer in your ${view.stage} interview`
    : view.status === 'DECLINED' ? 'The observer will not be used'
      : view.status === 'STOPPED' ? 'The observer has been stopped'
        : view.status === 'ENDED' ? 'This interview has ended'
          : 'You agreed to the observer';
  return (
    <section className="card auth-card observer-candidate" aria-labelledby="observer-candidate-title">
      <h2 id="observer-candidate-title">{heading}</h2>
      <p>{view.notice}</p>
      {(view.listening || view.canStop) && <ListeningIndicator listening={view.listening} />}
      {view.status === 'DECLINED' && <p className="muted">Nothing will be captured. Your interview goes ahead as normal.</p>}
      {view.status === 'STOPPED' && <p className="muted">Capture ended when it was stopped. Your interview goes ahead as normal.</p>}
      {view.status === 'CONSENTED' && <p className="muted">The interviewer will start it. You can stop it at any time from this page.</p>}
      <div className="row">
        {view.canConsent && (
          <button type="button" className="btn" disabled={busy} onClick={onConsent}>I agree</button>
        )}
        {view.canDecline && (
          <button type="button" className="btn ghost" disabled={busy} onClick={onDecline}>No, thank you</button>
        )}
        {view.canStop && (
          <button type="button" className="btn danger" disabled={busy} onClick={onStop}>
            <Icon name="stop" size={16} />Stop the observer
          </button>
        )}
      </div>
    </section>
  );
}
