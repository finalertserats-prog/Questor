import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { Banner } from '../ui';
import { EmptyState } from '../EmptyState';
import { progressLabel, type TranscriptRow } from '../review/transcriptReaderModel';
import { useColumnReadProgress } from '../review/useTranscriptReader';
import type { TranscriptStatus } from '../review/TranscriptReader';

/**
 * The record of the interview, alongside the decision rather than under it.
 *
 * Pressing an evidence chip marks the quoted turn with a rule and scrolls THIS
 * column to it — not the page. Scrolling the whole page to a quotation is how
 * a reviewer loses the skill they were reading about; the two have to be on
 * screen together for the evidence to be checkable at all.
 */

export interface AssessmentTranscriptProps {
  readonly status: TranscriptStatus;
  readonly rows: readonly TranscriptRow[];
  readonly error: string;
  readonly onRetry: () => void;
  /** The turn an evidence chip is pointing at, or '' for none. */
  readonly quotedTurnId: string;
  /** Changes on every chip press, so pressing the same chip twice scrolls again. */
  readonly quotedAt: number;
  readonly transcriptKey: string;
  readonly onRead: (read: boolean) => void;
}

export function AssessmentTranscript(props: AssessmentTranscriptProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const ready = props.status === 'ready';
  const { fraction, read } = useColumnReadProgress(bodyRef, ready, props.transcriptKey);
  const { onRead } = props;

  useEffect(() => { onRead(read); }, [onRead, read]);

  // Scrolls the column only. `quotedAt` is in the dependencies so choosing the
  // same chip again brings the turn back into view rather than doing nothing.
  useEffect(() => {
    if (!props.quotedTurnId) return;
    const body = bodyRef.current;
    if (!body) return;
    // Matched by reading the attribute rather than by building a selector from
    // it: an id is data, and putting data into a selector needs CSS.escape,
    // which is not everywhere. Comparing the value is exact and always works.
    const turn = [...body.querySelectorAll<HTMLElement>('[data-turn-id]')]
      .find((el) => el.dataset.turnId === props.quotedTurnId);
    if (!turn) return;
    const top = turn.offsetTop - body.offsetTop - 8;
    // Element.scrollTo is not everywhere (and is absent in the test DOM), so
    // the plain assignment is the fallback. Never scrollIntoView: that moves
    // the PAGE, which takes the skill being read off the screen — the one
    // thing this whole arrangement exists to prevent.
    if (typeof body.scrollTo === 'function') body.scrollTo({ top, behavior: 'smooth' });
    else body.scrollTop = top;
  }, [props.quotedTurnId, props.quotedAt]);

  return (
    <aside className="tx" aria-labelledby="tx-heading" data-testid="assessment-transcript">
      <div className="tx-h">
        <h2 id="tx-heading"><Icon name="captions" size={16} />Transcript</h2>
        {ready && props.rows.length > 0 && (
          <span className="tx-progress" data-testid="transcript-progress" data-read={read ? 'true' : 'false'}>
            {progressLabel(read ? 1 : fraction)}
          </span>
        )}
      </div>

      <div className="tx-body" ref={bodyRef} tabIndex={0} role="region" aria-label="Interview transcript">
        {props.status === 'loading' && <p className="muted">Loading the transcript…</p>}

        {props.status === 'failed' && (
          <Banner kind="error">
            {props.error || 'The transcript could not be loaded.'}{' '}
            <button type="button" className="btn secondary sm" onClick={props.onRetry}>Try again</button>
          </Banner>
        )}

        {ready && props.rows.length === 0 && (
          <EmptyState compact icon="interviews" title="No transcript" message="This interview left no turns to read." />
        )}

        {ready && props.rows.length > 0 && (
          <ol className="tx-turns" role="list">
            {props.rows.map((row) => {
              const quoted = row.turnId !== null && row.turnId === props.quotedTurnId;
              return (
                <li
                  key={row.key}
                  className={`tx-turn is-${row.voice}${quoted ? ' is-quoted' : ''}`}
                  data-turn-id={row.turnId ?? undefined}
                  data-testid="transcript-turn"
                >
                  {quoted && <span className="tx-quoted-tag">[ quoted ]</span>}
                  <p className="tx-meta">
                    <span className="tx-who">{row.label}</span>
                    {row.stamp && <time className="tx-at">{row.stamp}</time>}
                    {row.competency && <span className="tx-tag">{row.competency}</span>}
                  </p>
                  {row.leftByButton
                    ? <p className="tx-text muted"><em>Candidate chose to leave the interview.</em></p>
                    : <p className="tx-text">{row.text}</p>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}
