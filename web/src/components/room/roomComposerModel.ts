/**
 * Rules for the answer composer: which ways of answering are open, and when
 * the room suggests the code editor.
 */

export type ComposerMode = 'speak' | 'type' | 'code';

export function composerMode(textMode: boolean, codeMode: boolean): ComposerMode {
  if (!textMode) return 'speak';
  return codeMode ? 'code' : 'type';
}

export const MIC_UNAVAILABLE_NOTE =
  "Speaking isn't available because voice capture wasn't agreed at the start. Type your answer instead — it counts exactly the same.";
const NO_BROWSER_STT_NOTE =
  "Speaking isn't available in this browser. Type your answer instead — it counts exactly the same.";

/**
 * Why speaking is unavailable, or null when it is available.
 *
 * Consent comes first: a candidate who declined voice capture is never asked
 * for the microphone, whatever the browser can do.
 */
export function speakAvailability(o: { consented: boolean; sttSupported: boolean }): string | null {
  if (!o.consented) return MIC_UNAVAILABLE_NOTE;
  if (!o.sttSupported) return NO_BROWSER_STT_NOTE;
  return null;
}

// A request to produce code: a writing verb and a code noun in one sentence.
// Deliberately narrow. "Tell me about your SQL experience" or "how would that
// query behave?" are talking questions, and flipping the box to a code editor
// for them would be a nuisance; a missed coding question costs one click.
const WRITE_CODE = /\b(write|implement|code up|sketch|draft|type out)\b[^.?!]*\b(sql|quer(?:y|ies)|functions?|code|program|script|method|class|algorithm|snippet|regex|pseudo-?code)\b/i;

export function isCodingQuestion(text: string): boolean {
  return text.split(/(?<=[.?!])\s+/).some((sentence) => WRITE_CODE.test(sentence));
}

export const CODE_NUDGE = 'Coding question — the answer box switched to a code editor. Switch back any time.';

export interface NewQuestionInput {
  readonly mode: ComposerMode;
  /** The mode the room switched away from automatically, if it did. */
  readonly autoFrom: ComposerMode | null;
  readonly coding: boolean;
  readonly canSpeak: boolean;
}

export interface NewQuestionMode {
  readonly mode: ComposerMode;
  readonly autoFrom: ComposerMode | null;
  readonly nudge: string | null;
}

/**
 * The composer mode when a new question arrives.
 *
 * Only the room's own switch is undone: a candidate who picked the code editor
 * themselves keeps it, because they chose it.
 */
export function modeForNewQuestion(input: NewQuestionInput): NewQuestionMode {
  if (input.coding) {
    if (input.mode === 'code') return { mode: 'code', autoFrom: input.autoFrom, nudge: input.autoFrom ? CODE_NUDGE : null };
    return { mode: 'code', autoFrom: input.mode, nudge: CODE_NUDGE };
  }
  if (input.autoFrom) {
    const back = input.autoFrom === 'speak' && !input.canSpeak ? 'type' : input.autoFrom;
    return { mode: back, autoFrom: null, nudge: null };
  }
  return { mode: input.mode, autoFrom: null, nudge: null };
}

export const INDENT = '  ';

/** Tab in the code editor: two spaces at the caret, replacing any selection. */
export function insertIndent(value: string, selectionStart: number, selectionEnd: number): { value: string; caret: number } {
  return {
    value: value.slice(0, selectionStart) + INDENT + value.slice(selectionEnd),
    caret: selectionStart + INDENT.length,
  };
}

export function composerHint(mode: ComposerMode): string {
  if (mode === 'code') return 'Tab indents · Esc then Tab leaves the editor · Ctrl+Enter sends';
  if (mode === 'type') return 'Ctrl+Enter sends';
  return 'Answer out loud on your turn · press the microphone when you’re done';
}

/**
 * A spoken answer assembled from its pieces. A pause, a check-in or a repeat
 * stops the recognizer mid-answer; what it heard is held and joined to what
 * comes after, so stopping to think never costs the candidate their words.
 */
export function joinAnswer(...parts: string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * One stretch of an answer between interruptions: what the recognizer heard,
 * and the recording of it. Either may be missing — a recognizer that failed
 * leaves audio with no words, and that audio is transcribed rather than lost.
 */
export interface HeldSegment {
  readonly text: string;
  readonly audio: Blob | null;
}

/** An answer that was interrupted (pause, check-in, repeat, typed text carried in), in order. */
export interface HeldAnswer {
  readonly segments: readonly HeldSegment[];
}

export const NOTHING_HELD: HeldAnswer = { segments: [] };

export function holdSegment(held: HeldAnswer, text: string, audio: Blob | null): HeldAnswer {
  const words = joinAnswer(text);
  if (!words && !audio) return held;
  return { segments: [...held.segments, { text: words, audio }] };
}

export function heldText(held: HeldAnswer): string {
  return joinAnswer(...held.segments.map((s) => s.text));
}

/** Indexes of segments that have audio but no words yet. */
export function untranscribed(held: HeldAnswer): number[] {
  return held.segments.flatMap((s, i) => (!s.text && s.audio ? [i] : []));
}

/** The answer in order, with wordless segments filled from their transcripts where there is one. */
export function answerFromHeld(held: HeldAnswer, transcripts: ReadonlyMap<number, string>): string {
  return joinAnswer(...held.segments.map((s, i) => s.text || transcripts.get(i) || ''));
}

/**
 * What "Leave" puts in the transcript. Leave is an action, recorded as one on
 * the server (source "leave_button"), so the transcript shows a neutral marker
 * rather than a sentence the candidate never said. Must match the server's.
 */
export const LEAVE_MARKER = '(Left the interview)';
