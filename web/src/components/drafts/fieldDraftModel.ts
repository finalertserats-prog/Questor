import type { KeyboardEvent } from 'react';

/**
 * How an offered draft behaves, kept free of React so the rules that matter
 * most — the ones about keyboards and screen readers — can be tested without
 * a browser.
 *
 * The rules, and why each one is a rule:
 *
 *  - A draft is REAL TEXT in the page, never the `placeholder` attribute. A
 *    placeholder is grey-on-white by design, fails AA at the contrast the
 *    trick depends on, disappears the moment a character is typed, and is
 *    announced inconsistently — so a "suggestion" carried in one is invisible
 *    to a good share of the people it is offered to.
 *  - It never steals focus and never submits. It appears beside the field the
 *    person is already in; taking it is always an act.
 *  - Tab accepts ONLY while the draft is showing and the field is still empty.
 *    Once they have typed, Tab is how a keyboard user leaves the field, and
 *    stealing that would trap them.
 *  - Typing dismisses it, and it does not come back by itself. Re-offering on
 *    every keystroke is a model call per character and a suggestion that
 *    fights the person writing.
 */

export type DraftPhase = 'idle' | 'loading' | 'offered' | 'taken' | 'dismissed' | 'off';

export interface DraftState {
  readonly phase: DraftPhase;
  /** The text on offer. Only meaningful while `offered`. */
  readonly text: string;
}

export const IDLE: DraftState = { phase: 'idle', text: '' };

/** Announced politely, so a screen-reader user learns a draft arrived without being interrupted. */
export function draftAnnouncement(state: DraftState): string {
  if (state.phase === 'loading') return 'Drafting a suggestion.';
  if (state.phase === 'offered') return 'A suggested draft is available below this field. Press Tab to use it.';
  if (state.phase === 'taken') return 'Suggested draft used. The text is now yours to edit.';
  return '';
}

/**
 * Should a draft be asked for at all?
 *
 * Only for a field that allows one, only when it is empty — a draft over
 * someone's words is a draft nobody asked for — and only once: a field that
 * has already been offered something, or dismissed, does not ask again unless
 * the person asks it to.
 */
export function shouldOfferDraft(o: {
  readonly allowed: boolean;
  readonly value: string;
  readonly phase: DraftPhase;
}): boolean {
  return o.allowed && o.value.trim() === '' && o.phase === 'idle';
}

/**
 * Tab accepts the draft — but only while it is the only thing Tab could
 * usefully do. `false` means "let Tab do what Tab does".
 */
export function tabAccepts(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>, o: {
  readonly phase: DraftPhase;
  readonly value: string;
}): boolean {
  if (event.key !== 'Tab' || event.shiftKey) return false;
  return o.phase === 'offered' && o.value === '';
}

/** Typing over an offer dismisses it. Nothing re-offers by itself. */
export function afterTyping(state: DraftState): DraftState {
  return state.phase === 'offered' || state.phase === 'loading' ? { phase: 'dismissed', text: '' } : state;
}

/**
 * What the server's answer means. An empty text is not a failure to report:
 * it is the deliberate "nothing rather than something bad" path, and the
 * person should simply see no suggestion.
 */
export function stateFromReply(reply: { readonly text: string; readonly disabled: boolean }): DraftState {
  if (reply.disabled) return { phase: 'off', text: '' };
  return reply.text.trim() === '' ? { phase: 'dismissed', text: '' } : { phase: 'offered', text: reply.text };
}
