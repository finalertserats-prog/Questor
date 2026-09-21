import { forwardRef } from 'react';
import { Banner } from '../ui';
import { Icon } from '../Icon';
import { EmptyState } from '../EmptyState';
import {
  progressLabel, readNote, TRANSCRIPT_END_ID, type ReviewFact, type TranscriptRow,
} from './transcriptReaderModel';

/**
 * The transcript, first. The review page opens with the record of the
 * interview so the reviewer reads what was said before they read what the AI
 * made of it — and before the form asks for their verdict.
 *
 * The block is the full transcript in the page's own flow, not a scrolling
 * box: how far down the page the reviewer is IS how far they have read, which
 * is what the progress label and the note beside the form report. The bar
 * along the top stays in view while the transcript does, so a long one can
 * be left for the review and come back to.
 */

export type TranscriptStatus = 'loading' | 'ready' | 'failed';

export interface TranscriptReaderProps {
  readonly status: TranscriptStatus;
  readonly rows: readonly TranscriptRow[];
  readonly fraction: number;
  readonly read: boolean;
  readonly showJump: boolean;
  readonly onJump: () => void;
  readonly onRetry: () => void;
  readonly error: string;
}

export const TranscriptReader = forwardRef<HTMLElement, TranscriptReaderProps>(function TranscriptReader(
  { status, rows, fraction, read, showJump, onJump, onRetry, error }, ref,
) {
  return (
    <section ref={ref} className="reader card" data-testid="transcript-reader" aria-labelledby="transcript-heading">
      <div className="reader-bar">
        <h2 id="transcript-heading" className="card-title"><Icon name="captions" />Transcript</h2>
        {status === 'ready' && rows.length > 0 && (
          <div className="reader-bar-side">
            {/* Not a live region: it changes on every scroll, and a screen
                reader announcing "Read 41%" over the transcript would be worse
                than silence. The note beside the form says so once, at the end. */}
            <span className="reader-progress" data-testid="transcript-progress" data-read={read ? 'true' : 'false'}>
              {progressLabel(read ? 1 : fraction)}
            </span>
            {showJump && (
              <button type="button" className="btn ghost sm" onClick={onJump} data-testid="jump-to-review">
                <Icon name="arrow-right" size={14} />Jump to review
              </button>
            )}
          </div>
        )}
      </div>

      {status === 'loading' && <p className="muted" style={{ margin: 0 }}>Loading the transcript…</p>}

      {status === 'failed' && (
        <Banner kind="error">
          {error || 'The transcript could not be loaded.'}{' '}
          <button type="button" className="btn secondary sm" onClick={onRetry}>Try again</button>
        </Banner>
      )}

      {status === 'ready' && rows.length === 0 && (
        <EmptyState compact icon="interviews" title="No transcript" message="This interview left no turns to read." />
      )}

      {status === 'ready' && rows.length > 0 && (
        <>
          {/* role="list" because list-style: none strips list semantics in Safari. */}
          <ol className="reader-turns" role="list">
            {rows.map((row) => (
              <li key={row.key} className={`reader-turn is-${row.voice}`} data-testid="transcript-turn">
                <div className="reader-meta">
                  <span className="reader-who">{row.label}</span>
                  {row.stamp && <time className="reader-stamp">{row.stamp}</time>}
                  {row.competency && <span className="reader-tag">{row.competency}</span>}
                </div>
                {row.leftByButton
                  ? <p className="reader-text muted"><em>Candidate chose to leave the interview.</em></p>
                  : <p className="reader-text">{row.text}</p>}
              </li>
            ))}
          </ol>
          <div id={TRANSCRIPT_END_ID} className="reader-end" data-testid="transcript-end">
            End of transcript · {rows.length} turns
          </div>
        </>
      )}
    </section>
  );
});

/** The note beside the review: a request until the end has been on screen, then a confirmation. */
export function TranscriptReadNote({ read }: { readonly read: boolean }) {
  return (
    <p className={read ? 'reader-note is-read' : 'reader-note'} data-testid="transcript-read-note" role="status">
      <Icon name={read ? 'check-circle' : 'evidence'} size={16} />
      {readNote(read)}
    </p>
  );
}

/** Candidate, role, interviewer, date, duration — the compact header above the transcript. */
export function ReviewFactsStrip({ facts }: { readonly facts: readonly ReviewFact[] }) {
  return (
    <dl className="review-facts" data-testid="review-facts">
      {facts.map((fact) => (
        <div key={fact.label} className="review-fact">
          <dt>{fact.label}</dt><dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
