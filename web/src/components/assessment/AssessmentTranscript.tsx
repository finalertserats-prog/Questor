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
 *
 * It is also where the transcript requirement is satisfied. Each turn reports
 * itself as shown when it enters the column OR when it takes focus, and the
 * end-of-transcript marker at the bottom reports the lot. Both paths exist
 * because neither covers everyone: an intersection observer never fires for a
 * reader whose software walks the rendered list without scrolling, and focus
 * never moves for someone who only scrolls. Every turn is therefore focusable
 * and in the tab order, and the end marker is a real focusable element rather
 * than a sentinel div — a keyboard or screen-reader user has to be able to
 * reach it, because it is the only thing that satisfies the gate in one step.
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
  /** A turn was put in front of the reviewer (seen or focused). */
  readonly onTurnSeen?: (index: number) => void;
  /** The end of the transcript was reached, which counts everything above it. */
  readonly onEndReached?: () => void;
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

  /**
   * Report turns as they come into the column, and the end when it arrives.
   *
   * Re-created per transcript, and only once the rows are on screen. Where
   * IntersectionObserver is missing (an older browser, the test DOM) this is
   * simply absent — focus and the end marker still satisfy the gate, which is
   * why both paths exist.
   */
  const { onTurnSeen, onEndReached } = props;
  useEffect(() => {
    if (!ready || typeof IntersectionObserver !== 'function') return;
    const body = bodyRef.current;
    if (!body) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        if (el.dataset.endMarker === 'true') onEndReached?.();
        else if (el.dataset.turnIndex !== undefined) onTurnSeen?.(Number(el.dataset.turnIndex));
      }
    }, { root: body, threshold: 0.4 });
    for (const el of body.querySelectorAll<HTMLElement>('[data-turn-index], [data-end-marker]')) observer.observe(el);
    return () => observer.disconnect();
  }, [ready, props.transcriptKey, props.rows.length, onTurnSeen, onEndReached]);

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
                  data-turn-index={row.turnIndex}
                  data-testid="transcript-turn"
                  // In the tab order, so a keyboard or screen-reader user
                  // moving through the transcript reports the same turns a
                  // scrolling reader does. A list of turns is a long tab stop
                  // run, which is why the end marker exists beside it.
                  tabIndex={0}
                  onFocus={() => onTurnSeen?.(row.turnIndex)}
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

        {ready && props.rows.length > 0 && (
          /* A real focusable element, not a sentinel: for a reviewer who does
             not scroll, this is the one control that says "I have reached the
             end", and it must be reachable by Tab and announceable. */
          <button
            type="button"
            className="tx-end"
            data-end-marker="true"
            data-testid="transcript-end"
            onFocus={() => onEndReached?.()}
            onClick={() => onEndReached?.()}
          >
            <Icon name="check-circle" size={15} />
            End of transcript
          </button>
        )}
      </div>
    </aside>
  );
}
