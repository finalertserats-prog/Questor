import { formatDateTime } from '../dateFormat';
import { NO_SCORE } from '../scoreFormat';

/**
 * The transcript the reviewer reads before recording a verdict, kept free of
 * React so the labelling and the read-progress arithmetic are tested on their
 * own (web/tests/transcriptReaderModel.test.ts).
 *
 * WHY the transcript comes first: a review recorded from the AI's summary is a
 * review of the summary. The owner asked for the record itself to be in front
 * of the reviewer before the form is — and for the page to know how far they
 * have read, so the note beside the form can say so. None of this is stored:
 * it is guidance on the page, not a gate on the server.
 */

export interface TranscriptTurnInput {
  readonly index: number;
  readonly speaker: string;
  readonly text: string;
  readonly startMs?: number | null;
  readonly competencyId?: string | null;
  /** Set when the turn is the candidate pressing Leave rather than anything they said. */
  readonly source?: string;
}

export type TranscriptVoice = 'interviewer' | 'candidate' | 'system';

export interface TranscriptRow {
  readonly key: string;
  readonly voice: TranscriptVoice;
  readonly label: string;
  readonly text: string;
  /** mm:ss into the interview, or null when the source did not record a time. */
  readonly stamp: string | null;
  /** The competency the question was asked for; interviewer turns only. */
  readonly competency: string | null;
  readonly leftByButton: boolean;
}

export interface TranscriptNames {
  readonly interviewer?: string | null;
  readonly candidate?: string | null;
}

const LEAVE_SOURCE = 'leave_button';

function voiceOf(speaker: string): TranscriptVoice {
  if (speaker === 'agent') return 'interviewer';
  return speaker === 'candidate' ? 'candidate' : 'system';
}

function stampOf(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The turns as the reader shows them. The competency tag sits on the
 * interviewer's turn only: it is the question that was asked for a
 * competency, and tagging the answer as well would read as a grade.
 */
export function transcriptRows(
  turns: readonly TranscriptTurnInput[],
  competencyNames: Readonly<Record<string, string>>,
  names: TranscriptNames,
): TranscriptRow[] {
  const labels: Record<TranscriptVoice, string> = {
    interviewer: names.interviewer?.trim() || 'Interviewer',
    candidate: names.candidate?.trim() || 'Candidate',
    system: 'System',
  };
  return [...turns]
    .sort((a, b) => a.index - b.index)
    .map((turn) => {
      const voice = voiceOf(turn.speaker);
      const competency = voice === 'interviewer' && turn.competencyId ? competencyNames[turn.competencyId] ?? null : null;
      return {
        key: String(turn.index),
        voice,
        label: labels[voice],
        text: turn.text,
        stamp: stampOf(turn.startMs),
        competency,
        leftByButton: turn.source === LEAVE_SOURCE,
      };
    });
}

// ---------------------------------------------------------------------------
// Read progress
// ---------------------------------------------------------------------------

export interface BlockGeometry {
  /** The block's top edge relative to the viewport (getBoundingClientRect().top). */
  readonly top: number;
  readonly height: number;
  readonly viewportHeight: number;
}

/**
 * How much of the block has passed the bottom of the viewport, 0 to 1. What is
 * counted is what has been on screen, which is the closest a page can get to
 * "read" without pretending to know more than it does.
 */
export function readFraction(g: BlockGeometry): number {
  if (g.height <= 0) return 1;
  const seen = g.viewportHeight - g.top;
  const fraction = Math.min(1, Math.max(0, seen / g.height));
  // Two decimals: a few pixels short of the end is the end, and the label
  // never shows more precision than a percentage anyway.
  return Math.round(fraction * 100) / 100;
}

export function isTranscriptRead(fraction: number): boolean {
  return fraction >= 1;
}

/** Latched: scrolling back up to check something does not un-read the transcript. */
export function nextReadState(previous: boolean, fraction: number): boolean {
  return previous || isTranscriptRead(fraction);
}

export const TRANSCRIPT_READ_LABEL = 'Transcript read';

export function progressLabel(fraction: number): string {
  return isTranscriptRead(fraction) ? TRANSCRIPT_READ_LABEL : `Read ${Math.round(fraction * 100)}%`;
}

const NOTE_PENDING = 'Read the transcript before recording your review.';
const NOTE_DONE = 'Transcript read.';

export function readNote(read: boolean): string {
  return read ? NOTE_DONE : NOTE_PENDING;
}

/** The review section the sticky control scrolls to. */
export const REVIEW_SECTION_ID = 'assessment-review';
/** The last element of the transcript block; a test scrolls it into view to reach "read". */
export const TRANSCRIPT_END_ID = 'transcript-end';

/** A jump control is noise on a transcript that fits on one screen. */
export function needsJumpControl(g: { readonly height: number; readonly viewportHeight: number }): boolean {
  return g.height > g.viewportHeight;
}

// ---------------------------------------------------------------------------
// The compact header
// ---------------------------------------------------------------------------

export interface ReviewFactsInput {
  readonly candidate: string;
  readonly role: string;
  readonly interviewer: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMinutes: number | null;
}

export interface ReviewFact {
  readonly label: string;
  readonly value: string;
}

export function durationText(o: Pick<ReviewFactsInput, 'startedAt' | 'completedAt' | 'durationMinutes'>): string {
  const started = o.startedAt ? new Date(o.startedAt).getTime() : Number.NaN;
  const completed = o.completedAt ? new Date(o.completedAt).getTime() : Number.NaN;
  if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
    return `${Math.max(1, Math.round((completed - started) / 60_000))} min`;
  }
  return typeof o.durationMinutes === 'number' && o.durationMinutes > 0 ? `${o.durationMinutes} min planned` : NO_SCORE;
}

/** What the reviewer needs to place the transcript, and nothing that scores it. */
export function reviewFacts(o: ReviewFactsInput): readonly ReviewFact[] {
  return [
    { label: 'Candidate', value: o.candidate },
    { label: 'Role', value: o.role },
    // No default name is invented for an old session; "AI interviewer" is what
    // the candidate was told they were meeting.
    { label: 'Interviewer', value: o.interviewer?.trim() || 'AI interviewer' },
    { label: 'Date', value: o.startedAt ? formatDateTime(o.startedAt) : NO_SCORE },
    { label: 'Duration', value: durationText(o) },
  ];
}

// ---------------------------------------------------------------------------
// The two sources the page reads from
// ---------------------------------------------------------------------------

export interface SessionFacts {
  readonly interviewer: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMinutes: number | null;
}

export interface TranscriptView {
  readonly rows: readonly TranscriptRow[];
  readonly facts: readonly ReviewFact[];
}

/** GET /interviews/:id/transcript. `session` is absent on an older server. */
export interface InterviewTranscriptResponse {
  readonly transcript: readonly TranscriptTurnInput[];
  readonly session?: SessionFacts | null;
}

export interface InterviewTranscriptContext {
  readonly candidate: string;
  readonly role: string;
  readonly competencyNames: Readonly<Record<string, string>>;
}

const NO_SESSION: SessionFacts = { interviewer: null, startedAt: null, completedAt: null, durationMinutes: null };

export function transcriptViewFromInterview(resp: InterviewTranscriptResponse, ctx: InterviewTranscriptContext): TranscriptView {
  const session = resp.session ?? NO_SESSION;
  return {
    rows: transcriptRows(resp.transcript ?? [], ctx.competencyNames, { interviewer: session.interviewer, candidate: ctx.candidate }),
    facts: reviewFacts({ candidate: ctx.candidate, role: ctx.role, ...session }),
  };
}

/** The fields of GET /assessments/:id/blind this reader uses. */
export interface BlindTranscriptSource {
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string };
  readonly session?: SessionFacts | null;
  readonly competencies: readonly { readonly id: string; readonly name: string }[];
  readonly transcript: readonly TranscriptTurnInput[];
}

export function transcriptViewFromBlind(view: BlindTranscriptSource): TranscriptView {
  const session = view.session ?? NO_SESSION;
  const competencyNames = Object.fromEntries(view.competencies.map((c) => [c.id, c.name]));
  return {
    rows: transcriptRows(view.transcript ?? [], competencyNames, { interviewer: session.interviewer, candidate: view.candidate.name }),
    facts: reviewFacts({ candidate: view.candidate.name, role: view.role.title, ...session }),
  };
}
