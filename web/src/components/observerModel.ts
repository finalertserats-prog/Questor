// Shapes and rules for the AI observer on human interview rounds. Mirrors
// server/src/services/roundObserver.ts; kept pure so the pages stay thin.

export type ObservationStatus = 'AWAITING_CONSENT' | 'CONSENTED' | 'LISTENING' | 'STOPPED' | 'DECLINED' | 'ENDED';
export type ObservedParty = 'candidate' | 'interviewer' | 'hr';

/** Why a round cannot go ahead, and what may be done instead. */
export interface RoomBlockView {
  reason: string;
  nextSteps: string[];
}

/** What the recording actually got, once the round is over. */
export interface CaptureReport {
  coverage: 'full' | 'partial' | 'one_sided' | 'none' | 'pending';
  sentence: string;
}

/** What the entry gate tells the person reading it, before and after they decide. */
export interface EntryGate {
  notice: string;
  noticeVersion: string;
  consequence: string;
  decided: 'pending' | 'consented' | 'declined';
  awaiting: ObservedParty[];
  mayEnter: boolean;
  refusal: RoomBlockView | null;
}
export type QuotesStatus = 'PENDING' | 'READY' | 'NONE' | 'UNAVAILABLE';

export interface TranscriptSegment {
  index: number;
  kind: 'SPEECH' | 'GAP';
  offsetMs: number;
  durationMs: number;
  text: string;
  /** Whose device heard it; null for a round captured before the room held more than one. */
  heardBy?: ObservedParty | null;
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
  declinedBy: ObservedParty | null;
  startedAt: string | null;
  stoppedBy: ObservedParty | null;
  /** Everyone the round knows about, by party. No names: see the server's comment. */
  participants: Array<{ party: ObservedParty; isYou: boolean; consentedAt: string | null; declinedAt: string | null; admittedAt: string | null }>;
  awaiting: ObservedParty[];
  blocked: RoomBlockView | null;
  stoppedAt: string | null;
  endedAt: string | null;
  readOnly: boolean;
  captureStatus: 'OK' | 'DEGRADED';
  captureReport?: CaptureReport;
  oneSided?: boolean;
  legalHold: boolean;
  candidateLink: string | null;
  transcript: TranscriptSegment[];
  quotes: { status: QuotesStatus; note: string; framing: string; items: unknown[] };
}

export interface ObserverRoundView {
  round: { id: string; candidateId: string; stageKey: string; status: string; aiObserver: boolean; scheduledAt: string; scheduledTimeZone?: string | null };
  you: { party: ObservedParty };
  notice: string;
  capture: {
    mode: 'server' | 'browser';
    provider: string;
    /** Whether the round is being heard at all; absent on an older server. */
    alarm?: { liveness: 'live' | 'silent' | 'never_started' | 'not_running'; warning: string; fixBy: 'interviewer' | null };
    /** Whether both voices are reaching the device. */
    hearing?: { oneSided: boolean; warning: string };
  };
  gate: EntryGate | null;
  observation: ObservationView | null;
}

export type RoomPhase =
  | 'unavailable'
  /** This person has not passed the entry gate yet, so they are not in the room. */
  | 'gate'
  /** They have agreed; somebody else has still to. */
  | 'awaiting_others'
  | 'listening'
  | 'stopped'
  | 'declined'
  | 'ended';

/**
 * Where this person's room is.
 *
 * The gate comes first, ahead of every other phase bar an unavailable round:
 * somebody who has not agreed must see the notice and nothing else, whatever
 * state the round itself is in. There is deliberately no phase for "in the room
 * but not being recorded" — there is no such state (domain/observedRound.ts).
 */
export function roomPhase(view: ObserverRoundView): RoomPhase {
  const { round, observation, gate } = view;
  if (!round.aiObserver) return 'unavailable';
  if (!observation) return 'unavailable';
  if (observation.status === 'DECLINED') return 'declined';
  if (observation.status === 'STOPPED') return 'stopped';
  if (observation.status === 'ENDED') return 'ended';
  if (!gate || gate.decided !== 'consented') return 'gate';
  return observation.status === 'LISTENING' ? 'listening' : 'awaiting_others';
}

/**
 * Why the round is not going ahead, in words a person can act on.
 *
 * The server's own sentence wherever there is one. The old copy here told the
 * reader to "run the round as normal; nothing is being captured", which is now
 * exactly the wrong instruction: a round that is not recorded produces no
 * evidence, so it is not a round to run.
 */
export function stopSentence(observation: Pick<ObservationView, 'status' | 'stoppedBy' | 'declinedBy' | 'blocked'>): string {
  if (observation.blocked) return observation.blocked.reason;
  if (observation.status === 'DECLINED' || observation.status === 'STOPPED') {
    return 'This round cannot go ahead: every human round is recorded, and not everyone who would be in the room '
      + 'has agreed to that.';
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
  consequence: string;
  decision: 'pending' | 'consented' | 'declined';
  canConsent: boolean;
  canDecline: boolean;
  canStop: boolean;
  listening: boolean;
  awaiting: ObservedParty[];
  refusal: RoomBlockView | null;
}

export function candidatePhase(view: CandidateConsentView): CandidatePhase {
  switch (view.status) {
    case 'AWAITING_CONSENT': return 'pending';
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

/**
 * How the observe page should present a failed load. 409 is the server saying
 * "not yet" (the candidate has not joined or heard the observer notice), which
 * is information to wait on, not an error to alarm about.
 */
export function observeLoadProblem(status: number | undefined): 'waiting' | 'error' {
  return status === 409 ? 'waiting' : 'error';
}
