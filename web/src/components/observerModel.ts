// Shapes and rules for the AI observer on human interview rounds. Mirrors
// server/src/services/roundObserver.ts; kept pure so the pages stay thin.

export type ObservationStatus = 'AWAITING_CANDIDATE' | 'CONSENTED' | 'LISTENING' | 'STOPPED' | 'DECLINED' | 'ENDED';
export type QuotesStatus = 'PENDING' | 'READY' | 'NONE' | 'UNAVAILABLE';

export interface TranscriptSegment {
  index: number;
  kind: 'SPEECH' | 'GAP';
  offsetMs: number;
  durationMs: number;
  text: string;
}

export interface EvidenceQuote {
  competencyId: string;
  competencyName: string;
  quote: string;
  segmentIndex: number;
  offsetMs: number;
}

export interface ObservationView {
  id: string;
  status: ObservationStatus;
  isInterviewer: boolean;
  interviewerConsentAt: string | null;
  candidateConsentAt: string | null;
  declinedBy: 'interviewer' | 'candidate' | null;
  startedAt: string | null;
  stoppedBy: 'interviewer' | 'candidate' | null;
  stoppedAt: string | null;
  endedAt: string | null;
  readOnly: boolean;
  captureStatus: 'OK' | 'DEGRADED';
  legalHold: boolean;
  candidateLink: string | null;
  transcript: TranscriptSegment[];
  quotes: { status: QuotesStatus; note: string; framing: string; items: unknown[] };
}

export interface ObserverRoundView {
  round: { id: string; candidateId: string; stageKey: string; status: string; aiObserver: boolean; scheduledAt: string };
  notice: string;
  capture: { mode: 'server' | 'browser'; provider: string };
  observation: ObservationView | null;
}

export type RoomPhase =
  | 'unavailable'
  | 'ask_interviewer'
  | 'awaiting_candidate'
  | 'ready'
  | 'listening'
  | 'stopped'
  | 'declined'
  | 'ended';

/** Where the interviewer's room is, from the server's view of the round. */
export function roomPhase(view: ObserverRoundView): RoomPhase {
  const { round, observation } = view;
  if (!round.aiObserver) return 'unavailable';
  if (!observation) return round.status === 'SCHEDULED' ? 'ask_interviewer' : 'unavailable';
  switch (observation.status) {
    case 'AWAITING_CANDIDATE': return 'awaiting_candidate';
    case 'CONSENTED': return 'ready';
    case 'LISTENING': return 'listening';
    case 'STOPPED': return 'stopped';
    case 'DECLINED': return 'declined';
    case 'ENDED': return 'ended';
    default: {
      const unknown: never = observation.status;
      throw new Error(`Unknown observer status ${String(unknown)}`);
    }
  }
}

/** Why the observer is not running, in words a person can act on. */
export function stopSentence(observation: Pick<ObservationView, 'status' | 'stoppedBy' | 'declinedBy'>): string {
  if (observation.status === 'DECLINED') {
    return observation.declinedBy === 'candidate'
      ? 'The candidate declined the observer. Run the round as normal; nothing is being captured.'
      : 'You declined the observer. Run the round as normal; nothing is being captured.';
  }
  if (observation.status === 'STOPPED') {
    return observation.stoppedBy === 'candidate'
      ? 'The candidate stopped the observer. Capture ended at that moment; carry on with the round as normal.'
      : 'The observer was stopped. Capture ended at that moment; carry on with the round as normal.';
  }
  return '';
}

/** 0:05, 12:40, 1:02:03 — a position in the round. */
export function formatOffset(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Only well-formed quotes are shown, and only their evidence fields. The server
 * already refuses anything else; this keeps the page from ever rendering a
 * field it was not designed to show.
 */
export function readQuotes(items: readonly unknown[]): EvidenceQuote[] {
  return items.flatMap((item) => (
    isRecord(item)
      && typeof item.competencyId === 'string' && typeof item.competencyName === 'string'
      && typeof item.quote === 'string' && typeof item.segmentIndex === 'number' && typeof item.offsetMs === 'number'
      ? [{ competencyId: item.competencyId, competencyName: item.competencyName, quote: item.quote, segmentIndex: item.segmentIndex, offsetMs: item.offsetMs }]
      : []
  ));
}

export interface CompetencyQuotes {
  competencyId: string;
  competencyName: string;
  quotes: EvidenceQuote[];
}

/** Quotes grouped by competency, in the order competencies first appear, each group in round order. */
export function groupQuotesByCompetency(quotes: readonly EvidenceQuote[]): CompetencyQuotes[] {
  const groups = quotes.reduce<CompetencyQuotes[]>((acc, quote) => {
    const existing = acc.find((g) => g.competencyId === quote.competencyId);
    return existing
      ? acc.map((g) => (g === existing ? { ...g, quotes: [...g.quotes, quote] } : g))
      : [...acc, { competencyId: quote.competencyId, competencyName: quote.competencyName, quotes: [quote] }];
  }, []);
  return groups.map((g) => ({ ...g, quotes: [...g.quotes].sort((a, b) => a.offsetMs - b.offsetMs) }));
}

/** The transcript in round order, whatever order the chunks arrived in. */
export function orderedTranscript(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((a, b) => a.offsetMs - b.offsetMs || a.index - b.index);
}

export function quotesStatusSentence(status: QuotesStatus, note: string): string {
  switch (status) {
    case 'PENDING': return 'Quotes are being extracted from the transcript.';
    case 'READY': return note;
    case 'NONE':
    case 'UNAVAILABLE': return note || 'No quotes were extracted.';
    default: {
      const unknown: never = status;
      return String(unknown);
    }
  }
}

export type CandidatePhase = 'pending' | 'consented' | 'listening' | 'declined' | 'stopped' | 'ended';

export interface CandidateConsentView {
  status: ObservationStatus;
  organisation: string;
  stage: string;
  notice: string;
  decision: 'pending' | 'consented' | 'declined';
  canConsent: boolean;
  canDecline: boolean;
  canStop: boolean;
  listening: boolean;
}

export function candidatePhase(view: CandidateConsentView): CandidatePhase {
  switch (view.status) {
    case 'AWAITING_CANDIDATE': return 'pending';
    case 'CONSENTED': return 'consented';
    case 'LISTENING': return 'listening';
    case 'DECLINED': return 'declined';
    case 'STOPPED': return 'stopped';
    case 'ENDED': return 'ended';
    default: {
      const unknown: never = view.status;
      throw new Error(`Unknown observer status ${String(unknown)}`);
    }
  }
}
