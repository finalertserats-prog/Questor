import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../api/client';
import { mayOfferDraft, mayTidy, type DraftFieldKey } from './fieldDraftVocabulary';
import {
  afterTyping, IDLE, shouldOfferDraft, stateFromReply, tabAccepts, type DraftState,
} from './fieldDraftModel';

/**
 * Asking for a draft, and taking one.
 *
 * Nothing is sent to the model until the field is focused or the person asks.
 * A field that has already been offered something does not ask again on every
 * focus: one draft per field per visit, and a control to ask for another.
 *
 * Every failure path ends in "no suggestion". A field that cannot be drafted
 * for is an ordinary empty text box, which is what it was before this feature
 * existed, so nothing here ever shows an error to interrupt someone writing.
 */

export interface FieldDraftOptions {
  readonly field: DraftFieldKey;
  /** What the field is about: a role title, a competency name, the stage. */
  readonly context: string;
  /** The field's current value, so an offer is never made over someone's words. */
  readonly value: string;
  /** Called with the draft when the person takes it. */
  readonly onAccept: (text: string) => void;
  /** What the accepted draft is recorded against, for the audit trail. */
  readonly entityType?: string;
  readonly entityId?: string;
}

export interface FieldDraft {
  readonly state: DraftState;
  readonly allowed: boolean;
  /** Put on the field: `aria-describedby`, so the offer is announced with it. */
  readonly describedBy: string | undefined;
  readonly panelId: string;
  readonly onFocus: () => void;
  readonly onTyped: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly accept: () => void;
  readonly dismiss: () => void;
  readonly offerAgain: () => void;
}

interface DraftReply { readonly text: string; readonly disabled: boolean }

/**
 * Whether this organisation has drafting switched off, remembered for the
 * session. The switch is a policy, not a per-field answer, so one refusal is
 * enough to stop asking on every field of every page.
 */
let draftingOff = false;

/** Test hook: forget what the server said about the organisation's switch. */
export function _resetDraftPolicyCache(): void {
  draftingOff = false;
}

export function useFieldDraft(opts: FieldDraftOptions): FieldDraft {
  const allowed = mayOfferDraft(opts.field);
  const [state, setState] = useState<DraftState>(IDLE);
  // A draft that arrives after the person has left the field, or started
  // typing, must not appear over what they are doing.
  const liveRef = useRef(0);
  const panelId = `draft-${opts.field}-${opts.entityId ?? 'new'}`;

  const ask = useCallback(async () => {
    if (draftingOff) return;
    const attempt = liveRef.current + 1;
    liveRef.current = attempt;
    setState({ phase: 'loading', text: '' });
    try {
      const reply = await api.post<DraftReply>('/drafts/suggest', { field: opts.field, context: opts.context.slice(0, 4000) });
      if (liveRef.current !== attempt) return;
      if (reply.disabled) draftingOff = true;
      setState(stateFromReply(reply));
    } catch {
      // Nothing rather than something bad, and nothing rather than an error
      // box over a field somebody is trying to type in.
      if (liveRef.current === attempt) setState({ phase: 'dismissed', text: '' });
    }
  }, [opts.field, opts.context]);

  const onFocus = useCallback(() => {
    if (!shouldOfferDraft({ allowed, value: opts.value, phase: state.phase })) return;
    void ask();
  }, [allowed, opts.value, state.phase, ask]);

  const onTyped = useCallback(() => {
    // Abandons any draft still in flight, so it cannot land over their words.
    liveRef.current += 1;
    setState((prev) => afterTyping(prev));
  }, []);

  const accept = useCallback(() => {
    if (state.phase !== 'offered') return;
    opts.onAccept(state.text);
    setState({ phase: 'taken', text: state.text });
    // Audited, and never allowed to fail the acceptance: the text is already
    // in the person's field, and an audit that did not write is our problem.
    void api.post('/drafts/accepted', {
      field: opts.field, source: 'suggestion',
      entityType: opts.entityType ?? '', entityId: opts.entityId ?? '',
    }).catch(() => undefined);
  }, [state, opts]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!tabAccepts(event, { phase: state.phase, value: opts.value })) return;
    event.preventDefault();
    accept();
  }, [state.phase, opts.value, accept]);

  return {
    state,
    allowed: allowed && !draftingOff,
    describedBy: state.phase === 'offered' ? panelId : undefined,
    panelId,
    onFocus,
    onTyped,
    onKeyDown,
    accept,
    dismiss: () => { liveRef.current += 1; setState({ phase: 'dismissed', text: '' }); },
    // Asked for, but still never over their words: "offer one" on a field they
    // have since typed into would put a suggestion under text it knows nothing
    // about, and accepting it would replace what they wrote.
    offerAgain: () => {
      if (opts.value.trim() !== '') return;
      setState(IDLE);
      void ask();
    },
  };
}

// ---------------------------------------------------------------------------
// Tidy up what I wrote
// ---------------------------------------------------------------------------

export type TidyPhase = 'idle' | 'working' | 'ready' | 'nothing';

export interface TidyState {
  readonly phase: TidyPhase;
  /** The tidied version, for the before-and-after. Empty unless `ready`. */
  readonly text: string;
}

export interface FieldTidy {
  readonly state: TidyState;
  readonly allowed: boolean;
  /** Only once the person has written something: there is nothing to tidy before that. */
  readonly offered: boolean;
  readonly run: () => void;
  readonly keep: () => void;
  readonly discard: () => void;
}

/** Below this there is nothing to tidy, and a rewrite would be an invention. */
export const MIN_TIDY_CHARS = 20;

export function useTidyUp(opts: {
  readonly field: DraftFieldKey;
  readonly value: string;
  readonly onAccept: (text: string) => void;
  readonly entityType?: string;
  readonly entityId?: string;
}): FieldTidy {
  const [state, setState] = useState<TidyState>({ phase: 'idle', text: '' });
  const allowed = mayTidy(opts.field) && !draftingOff;
  const offered = allowed && opts.value.trim().length >= MIN_TIDY_CHARS;
  /**
   * The exact text this tidy was asked for.
   *
   * A reviewer who presses "tidy up" and keeps typing would otherwise be shown
   * a before-and-after built from the sentence they have since changed — and
   * "keep the tidied version" would then overwrite the newer words with a
   * rewrite of the older ones. A tidy that no longer matches what is in the
   * box is dropped rather than offered.
   */
  const askedFor = useRef('');

  const run = useCallback(async () => {
    const submitted = opts.value;
    askedFor.current = submitted;
    setState({ phase: 'working', text: '' });
    try {
      const reply = await api.post<DraftReply>('/drafts/tidy', { field: opts.field, text: submitted.slice(0, 4000) });
      if (reply.disabled) draftingOff = true;
      if (askedFor.current !== submitted) return;
      setState(reply.text.trim() === '' ? { phase: 'nothing', text: '' } : { phase: 'ready', text: reply.text });
    } catch {
      if (askedFor.current === submitted) setState({ phase: 'nothing', text: '' });
    }
  }, [opts.field, opts.value]);

  const keep = useCallback(() => {
    if (state.phase !== 'ready') return;
    // Refused rather than applied: this rewrite is of a sentence the box no
    // longer holds, and keeping it would throw away what they typed since.
    if (askedFor.current !== opts.value) return;
    opts.onAccept(state.text);
    setState({ phase: 'idle', text: '' });
    void api.post('/drafts/accepted', {
      field: opts.field, source: 'tidy',
      entityType: opts.entityType ?? '', entityId: opts.entityId ?? '',
    }).catch(() => undefined);
  }, [state, opts]);

  // The before-and-after is about one specific sentence. The moment that
  // sentence changes the panel is about text that is no longer there, so it
  // stops being shown. Derived rather than stored: nothing is written during a
  // render, and the panel comes back by itself if the edit is undone.
  const stale = state.phase !== 'idle' && askedFor.current !== opts.value;

  return {
    state: stale ? { phase: 'idle', text: '' } : state,
    allowed,
    offered,
    run: () => { void run(); },
    keep,
    discard: () => setState({ phase: 'idle', text: '' }),
  };
}
