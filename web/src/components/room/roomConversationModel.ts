/** The running conversation, and the words the participant tiles use. */

export type RoomPhase = 'ready' | 'speaking' | 'listening' | 'thinking' | 'done';

export interface RoomMessage {
  readonly id: string;
  readonly speaker: 'agent' | 'candidate';
  readonly text: string;
  /** Time into the interview, when it is known. A resumed history carries none. */
  readonly atMs?: number | null;
  /** Written in the code editor: shown as code, with its indentation. */
  readonly code?: boolean;
  /** An interviewer check-in after a long silence, not a question. */
  readonly nudge?: boolean;
  /** The interviewer's closing turn. */
  readonly final?: boolean;
}

export interface TranscriptEntry {
  readonly speaker: 'agent' | 'candidate';
  readonly text: string;
}

/**
 * The conversation the room opens on: the opening on a fresh start, or on a
 * rejoin everything already said. The record keeps no times the room could
 * show, so rejoined lines carry none rather than a made-up one.
 */
export function fromTranscript(lines: readonly TranscriptEntry[], opts: { readonly fresh: boolean }): RoomMessage[] {
  return lines.map((line, i) => ({
    id: `history-${i}`,
    speaker: line.speaker,
    text: line.text,
    atMs: opts.fresh ? 0 : null,
  }));
}

/** How close to the bottom still counts as "reading the latest". */
const FOLLOW_SLACK_PX = 48;

/**
 * Whether new messages should scroll the conversation. Someone who scrolled up
 * to re-read an earlier answer must not be yanked back down mid-sentence.
 */
export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
}

export function aiStatus(phase: RoomPhase, paused: boolean): string {
  if (paused) return 'Waiting for you';
  switch (phase) {
    case 'ready': return 'Ready';
    case 'speaking': return 'Speaking';
    case 'thinking': return 'Thinking';
    case 'listening': return 'Listening';
    case 'done': return 'Signed off';
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

export function candidateStatus(o: { phase: RoomPhase; textMode: boolean; speakingNow: boolean }): string {
  if (o.textMode) return 'Typing';
  if (o.phase === 'listening') return o.speakingNow ? 'Speaking' : 'Your turn — speak now';
  return 'Mic ready';
}

export function avatarInitial(name: string | null | undefined): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed ? trimmed.charAt(0).toUpperCase() : 'AI';
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || 'Y';
}
