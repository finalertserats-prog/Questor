import { Icon } from '../Icon';
import { fieldDraftRule, type DraftFieldKey } from './fieldDraftVocabulary';
import { draftAnnouncement } from './fieldDraftModel';
import type { FieldDraft } from './useFieldDraft';

/**
 * The suggested draft, under the field it belongs to.
 *
 * Under, and not inside. A draft carried in the `placeholder` attribute is
 * grey by design — it cannot reach AA contrast and stay a "hint" — it vanishes
 * at the first keystroke, and assistive technology treats it inconsistently.
 * So the draft is real text, at ordinary reading contrast, in a block with its
 * own heading, its own accept and its own dismiss.
 *
 * It never takes focus and never submits anything. "Use this" and Tab both do
 * the same single thing: put the text in the field, where it becomes the
 * person's to edit or delete.
 *
 * Marked with a rule and an icon rather than a tinted fill, like everything
 * else that marks state in this product.
 */

export function SuggestedDraft({ draft }: { readonly draft: FieldDraft }) {
  const { state } = draft;

  // A live region that is always mounted: one mounted at the moment the text
  // arrives is not announced at all by several screen readers.
  const announcement = (
    <span className="sr-only" role="status" aria-live="polite">{draftAnnouncement(state)}</span>
  );

  if (state.phase === 'loading') {
    return (
      <div className="sug-quiet" data-testid="draft-loading">
        {announcement}
        <Icon name="hourglass" size={14} />
        Drafting a suggestion…
      </div>
    );
  }

  if (state.phase === 'taken') {
    return (
      <p className="sug-taken" data-testid="draft-taken">
        {announcement}
        <span className="sug-taken-mark"><Icon name="check" size={13} />Draft taken</span>
        <span>Edit it freely — it is your text now.</span>
      </p>
    );
  }

  if (state.phase === 'dismissed') {
    return (
      <p className="sug-quiet" data-testid="draft-dismissed">
        No suggestion.
        <button type="button" className="link-button" onClick={draft.offerAgain}>Offer one</button>
      </p>
    );
  }

  if (state.phase !== 'offered') return announcement;

  return (
    <div className="sug" id={draft.panelId} role="group" aria-label="Suggested draft" data-testid="draft-offer">
      {announcement}
      <p className="sug-h">
        <span className="sug-label"><Icon name="sparkle" size={13} />Suggested draft — AI</span>
        <span className="sug-key">Tab to accept</span>
      </p>
      <p className="sug-text" data-testid="draft-text">{state.text}</p>
      <p className="sug-acts">
        <button type="button" className="btn sm" onClick={draft.accept} data-testid="draft-accept">Use this</button>
        <button type="button" className="btn secondary sm" onClick={draft.dismiss} data-testid="draft-dismiss">Dismiss</button>
        <span className="sug-foot">Or type your own — the suggestion goes away.</span>
      </p>
    </div>
  );
}

/**
 * Why no draft is offered here. Shown under the fields that hold a person's
 * own judgement, because an absent feature reads as an oversight, and this one
 * is a decision worth stating.
 */
export function NoDraftNote({ field }: { readonly field: DraftFieldKey }) {
  const rule = fieldDraftRule(field);
  if (rule.suggest || !rule.refusal) return null;
  return (
    <p className="no-draft" data-testid="no-draft-note">
      <span className="no-draft-mark"><Icon name="alert" size={13} />Your words, not the AI's</span>
      <span>{rule.refusal}</span>
    </p>
  );
}
