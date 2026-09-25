import { useEffect, useRef, useState, type RefObject } from 'react';
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
  /**
   * The blind payload this view was built from, when that is where it came
   * from. Kept because the assessment page draws its masked competency cards
   * from the same response — the scorecard's competencies and the evidence
   * quotes — and fetching /blind a second time would record a second "opened"
   * notice for one visit.
   */
  readonly blind: BlindTranscriptSource | null;
}

const LOADING: TranscriptState = { status: 'loading', view: null, error: '', blind: null };

function sourceKey(source: TranscriptSource | null): string {
  if (!source) return '';
  return source.kind === 'interview' ? `interview:${source.sessionId}` : `blind:${source.assessmentId}`;
}

async function fetchView(source: TranscriptSource): Promise<{ view: TranscriptView; blind: BlindTranscriptSource | null }> {
  if (source.kind === 'blind') {
    const blind = await api.get<BlindTranscriptSource>(`/assessments/${source.assessmentId}/blind`);
    return { view: transcriptViewFromBlind(blind), blind };
  }
  const resp = await api.get<InterviewTranscriptResponse>(`/interviews/${source.sessionId}/transcript`);
  return { view: transcriptViewFromInterview(resp, source), blind: null };
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
      .then(({ view, blind }) => { if (!cancelled) setState({ status: 'ready', view, error: '', blind }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'failed', view: null, blind: null, error: err instanceof Error ? err.message : 'The transcript could not be loaded.' });
      });
    return () => { cancelled = true; };
  }, [key, attempt]);

  return { ...state, key, retry: () => setAttempt((n) => n + 1) };
}

/**
 * How far down the transcript block the page has been scrolled. Measured
 * from the window, because the transcript sits in the page's own flow: the
 * page IS the reading surface.
 *
 * This is the label, not the gate — nothing here is stored. What the server
 * holds the reviewer to is which turns were shown, in useTranscriptReadGate.
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
    target.focus({ preventScroll: true });
  };

  return { blockRef, fraction, read, showJump, jumpToReview };
}

/**
 * The same reading, for the transcript when it sits in its own scrolling
 * column beside the decision rather than in the page's flow.
 *
 * The redesigned assessment page puts the decision at the top and the record
 * alongside it, so "how far down the page you are" stopped being "how far you
 * have read". What is measured is the column's own scroll instead — through
 * the same pure arithmetic (readFraction), so the label cannot come to mean
 * one thing in one layout and something else in the other.
 */
export function useColumnReadProgress(
  ref: RefObject<HTMLElement>, ready: boolean, transcriptKey: string,
) {
  const [fraction, setFraction] = useState(0);
  const [read, setRead] = useState(false);

  useEffect(() => {
    // Per transcript, not per visit: the next assessment starts unread.
    setFraction(0);
    setRead(false);
    if (!ready) return;
    const column = ref.current;
    if (!column) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      // A column that does not scroll has been read the moment it is on screen.
      const next = readFraction({ top: -el.scrollTop, height: el.scrollHeight, viewportHeight: el.clientHeight });
      setFraction(next);
      setRead((previous) => nextReadState(previous, next));
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    measure();
    column.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      column.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ref, ready, transcriptKey]);

  return { fraction, read };
}

