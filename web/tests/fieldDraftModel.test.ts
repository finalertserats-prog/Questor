import { describe, expect, it } from 'vitest';
import {
  afterTyping, draftAnnouncement, IDLE, shouldOfferDraft, stateFromReply, tabAccepts,
} from '../src/components/drafts/fieldDraftModel';
import {
  DRAFT_FIELD_KEYS, fieldDraftRule, mayOfferDraft, mayTidy,
} from '../src/components/drafts/fieldDraftVocabulary';

/**
 * How an offered draft behaves. The rules that matter most are the ones about
 * keyboards and about the boundary, so they are tested without a browser.
 */

describe('which fields may be drafted', () => {
  it('never offers a draft for the record of a human judgement', () => {
    expect(mayOfferDraft('verdict_reason')).toBe(false);
    expect(mayOfferDraft('evidence_note')).toBe(false);
    expect(mayOfferDraft('level_override_reason')).toBe(false);
  });

  it('never offers a draft for a human\'s own observations of a candidate', () => {
    expect(mayOfferDraft('round_note')).toBe(false);
  });

  it('offers one for role content and candidate messages', () => {
    expect(mayOfferDraft('role_summary')).toBe(true);
    expect(mayOfferDraft('job_description')).toBe(true);
    expect(mayOfferDraft('competency_definition')).toBe(true);
    expect(mayOfferDraft('candidate_message')).toBe(true);
  });

  it('allows tidying everywhere, because tidying cannot originate a judgement', () => {
    for (const key of DRAFT_FIELD_KEYS) expect(mayTidy(key)).toBe(true);
  });

  it('gives every undraftable field a sentence saying why', () => {
    for (const key of DRAFT_FIELD_KEYS) {
      const rule = fieldDraftRule(key);
      if (!rule.suggest) expect(rule.refusal.length).toBeGreaterThan(20);
      else expect(rule.refusal).toBe('');
    }
  });
});

describe('when a draft is asked for', () => {
  it('is asked for once, on an empty field that allows one', () => {
    expect(shouldOfferDraft({ allowed: true, value: '', phase: 'idle' })).toBe(true);
  });

  it('is never asked for over what somebody has written', () => {
    expect(shouldOfferDraft({ allowed: true, value: 'my own words', phase: 'idle' })).toBe(false);
  });

  it('is not asked for again once it has been dismissed', () => {
    expect(shouldOfferDraft({ allowed: true, value: '', phase: 'dismissed' })).toBe(false);
    expect(shouldOfferDraft({ allowed: true, value: '', phase: 'offered' })).toBe(false);
  });

  it('is never asked for on a field that does not allow one', () => {
    expect(shouldOfferDraft({ allowed: false, value: '', phase: 'idle' })).toBe(false);
  });
});

describe('Tab', () => {
  it('accepts the draft while it is showing and the field is still empty', () => {
    expect(tabAccepts({ key: 'Tab', shiftKey: false }, { phase: 'offered', value: '' })).toBe(true);
  });

  it('leaves the field, as Tab must, once the person has typed', () => {
    expect(tabAccepts({ key: 'Tab', shiftKey: false }, { phase: 'offered', value: 'mine' })).toBe(false);
  });

  it('leaves Shift+Tab alone, which is how a keyboard user goes back', () => {
    expect(tabAccepts({ key: 'Tab', shiftKey: true }, { phase: 'offered', value: '' })).toBe(false);
  });

  it('does nothing when there is no draft on offer', () => {
    expect(tabAccepts({ key: 'Tab', shiftKey: false }, { phase: 'idle', value: '' })).toBe(false);
  });

  it('leaves every other key to the browser', () => {
    expect(tabAccepts({ key: 'Enter', shiftKey: false }, { phase: 'offered', value: '' })).toBe(false);
  });
});

describe('typing', () => {
  it('dismisses an offer, and a draft still in flight', () => {
    expect(afterTyping({ phase: 'offered', text: 'a draft' }).phase).toBe('dismissed');
    expect(afterTyping({ phase: 'loading', text: '' }).phase).toBe('dismissed');
  });

  it('leaves a draft the person already took alone', () => {
    expect(afterTyping({ phase: 'taken', text: 'theirs now' }).phase).toBe('taken');
  });
});

describe('what the server\'s answer means', () => {
  it('offers the text when there is some', () => {
    expect(stateFromReply({ text: 'A draft.', disabled: false })).toEqual({ phase: 'offered', text: 'A draft.' });
  });

  it('shows nothing rather than an empty suggestion', () => {
    expect(stateFromReply({ text: '   ', disabled: false }).phase).toBe('dismissed');
  });

  it('goes quiet entirely where the organisation has switched drafting off', () => {
    expect(stateFromReply({ text: '', disabled: true }).phase).toBe('off');
  });
});

describe('what a screen reader is told', () => {
  it('says a draft is available, and how to take it', () => {
    expect(draftAnnouncement({ phase: 'offered', text: 'x' })).toContain('Tab');
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(draftAnnouncement(IDLE)).toBe('');
    expect(draftAnnouncement({ phase: 'dismissed', text: '' })).toBe('');
  });
});
