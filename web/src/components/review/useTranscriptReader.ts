import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import {
  needsJumpControl, nextReadState, readFraction, REVIEW_SECTION_ID, transcriptViewFromBlind, transcriptViewFromInterview,
  type BlindTranscriptSource, type InterviewTranscriptResponse, type TranscriptView,
} from './transcriptReaderModel';
import type { TranscriptStatus } from './TranscriptReader';

/**
 * Where the review page gets its transcript from.
 *
 * Two sources on purpose. Once the assessment is open, the interview's own
 * transcript endpoint carries the turns and nothing the AI concluded. While
 * the organisation's blind-review policy is still withholding the assessment,
 * the page has no session id and must not fetch the interview detail (which
 * carries the AI result) — the blind view is built for exactly that reviewer,
 * and it carries the transcript too.
 */
export type TranscriptSource =
  | {
    readonly kind: 'interview';
    readonly sessionId: string;
    readonly candidate: string;
    readonly role: string;
    readonly competencyNames: Readonly<Record<string, string>>;
  }
  | { readonly kind: 'blind'; readonly assessmentId: string };

interface TranscriptState {
  readonly status: TranscriptStatus;
  readonly view: TranscriptView | null;
  readonly error: string;
}

const LOADING: TranscriptState = { status: 'loading', view: null, error: '' };

function sourceKey(source: TranscriptSource | null): string {
  if (!source) return '';
  return source.kind === 'interview' ? `interview:${source.sessionId}` : `blind:${source.assessmentId}`;
}

async function fetchView(source: TranscriptSource): Promise<TranscriptView> {
  if (source.kind === 'blind') {
    const view = await api.get<BlindTranscriptSource>(`/assessments/${source.assessmentId}/blind`);
    return transcriptViewFromBlind(view);
  }
  const resp = await api.get<InterviewTranscriptResponse>(`/interviews/${source.sessionId}/transcript`);
  return transcriptViewFromInterview(resp, source);
}

export function useReviewTranscript(source: TranscriptSource | null) {
  const [state, setState] = useState<TranscriptState>(LOADING);
  const [attempt, setAttempt] = useState(0);
  // The source object is rebuilt every render; only its identity matters,
  // so the effect keys on that and reads the latest object when it runs.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const key = sourceKey(source);

  useEffect(() => {
    const current = sourceRef.current;
    if (!current) return;
    let cancelled = false;
    setState(LOADING);
    fetchView(current)
      .then((view) => { if (!cancelled) setState({ status: 'ready', view, error: '' }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'failed', view: null, error: err instanceof Error ? err.message : 'The transcript could not be loaded.' });
      });
    return () => { cancelled = true; };
  }, [key, attempt]);

  return { ...state, key, retry: () => setAttempt((n) => n + 1) };
}

/**
 * How far down the transcript block the page has been scrolled. Measured
 * from the window, because the transcript sits in the page's own flow: the
 * page IS the reading surface. Nothing is stored.
 */
export function useReadProgress(ready: boolean, transcriptKey: string) {
  const blockRef = useRef<HTMLElement>(null);
  const [fraction, setFraction] = useState(0);
  const [read, setRead] = useState(false);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    // The latch is per transcript, not per visit: moving from one assessment
    // to the next in the same mounted page starts the new one unread.
    setFraction(0);
    setRead(false);
    setShowJump(false);
    if (!ready) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const block = blockRef.current;
      if (!block) return;
      const rect = block.getBoundingClientRect();
      const geometry = { top: rect.top, height: rect.height, viewportHeight: window.innerHeight };
      const next = readFraction(geometry);
      setFraction(next);
      setRead((previous) => nextReadState(previous, next));
      setShowJump(needsJumpControl(geometry));
    };
    // One measurement per frame however many scroll events arrive in it.
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ready, transcriptKey]);

  const jumpToReview = () => {
    const target = document.getElementById(REVIEW_SECTION_ID);
    if (!target) return;
    target.scrollIntoView({ block: 'start' });
    // Focus follows the jump so a keyboard user lands where they asked to go.
    target.focus({ preventScroll: true });
  };

  return { blockRef, fraction, read, showJump, jumpToReview };
}
