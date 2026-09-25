import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { evidenceDraftWarning, readyEntries, RoundRecord, type EvidenceDraft, type Round } from '../src/components/PipelinePanel';

/**
 * Closing a round records a claim per competency and the words it rests on.
 *
 * The form offers every competency on the scorecard, and most rounds speak to
 * only some of them, so an untouched row is the ordinary case rather than a
 * mistake. What is a mistake — and what the server refuses — is half a row: a
 * claim with no quote under it. The interviewer has to be told about that
 * before the round closes, not left to discover the competency was dropped.
 */

const COMPETENCIES = [
  { id: 'c1', name: 'Incident response' },
  { id: 'c2', name: 'Data modelling' },
];

const filled: EvidenceDraft = { competencyId: 'c1', claim: 'Owned it end to end.', quote: 'I paged myself at 2am.' };
const empty: EvidenceDraft = { competencyId: 'c2', claim: '', quote: '' };
const halfClaim: EvidenceDraft = { competencyId: 'c2', claim: 'Modelled it cleanly.', quote: '' };
const halfQuote: EvidenceDraft = { competencyId: 'c2', claim: '', quote: 'We denormalised the reads.' };

describe('which drafted entries are sent with the round', () => {
  it('sends a competency the interviewer filled in', () => {
    expect(readyEntries([filled])).toEqual([filled]);
  });

  // The round did not reach every competency, and saying nothing about one is
  // not the same as having nothing to say about the round.
  it('drops a competency the round never reached', () => {
    expect(readyEntries([filled, empty])).toEqual([filled]);
  });

  // Kept, not dropped. Closing a round is one-shot, so a competency quietly
  // omitted on the way through is omitted for good — and the interviewer would
  // be looking at a round that closed successfully. The submission is stopped
  // instead, which is a failure they can see and fix.
  it('keeps a claim with no quote, so it cannot be lost in silence', () => {
    expect(readyEntries([halfClaim])).toEqual([halfClaim]);
  });

  it('keeps a quote with no claim for the same reason', () => {
    expect(readyEntries([halfQuote])).toEqual([halfQuote]);
  });

  it('still drops a row where neither field was touched', () => {
    expect(readyEntries([empty])).toEqual([]);
  });
});

describe('what a half-written entry tells the interviewer', () => {
  it('says nothing when every entry is whole', () => {
    expect(evidenceDraftWarning([filled, empty], COMPETENCIES)).toBe('');
  });

  it('names the competency that is only half written', () => {
    expect(evidenceDraftWarning([filled, halfClaim], COMPETENCIES)).toContain('Data modelling');
  });

  // Silence here is the real failure: the round closes, the competency is
  // dropped, and nobody learns it was not recorded.
  it('says plainly that half an entry is not recorded', () => {
    expect(evidenceDraftWarning([halfQuote], COMPETENCIES)).toContain('half an entry is not recorded');
  });
});

const BASE: Round = {
  id: 'r1', stageKey: 'gold', conductedBy: 'HUMAN', aiObserver: true, hrMayObserve: false,
  sessionId: null, interviewers: [], scheduledAt: '2026-10-08T09:00:00.000Z', status: 'COMPLETED',
  notes: 'A strong round overall.',
};

const render = (round: Round) => renderToStaticMarkup(createElement(RoundRecord, { round }));

describe('a recorded round read back', () => {
  it('shows the claim under its competency', () => {
    const html = render({
      ...BASE,
      evidenceEntries: [{ competencyId: 'c1', competencyName: 'Incident response', claim: 'Owned it end to end.', quote: 'I paged myself at 2am.' }],
    });

    expect(html).toContain('Incident response');
  });

  // Set apart, not run together: a conclusion printed as prose beside its
  // support is how the two come to be read as one statement.
  it('sets the quote apart from the claim it supports', () => {
    const html = render({
      ...BASE,
      evidenceEntries: [{ competencyId: 'c1', competencyName: 'Incident response', claim: 'Owned it end to end.', quote: 'I paged myself at 2am.' }],
    });

    expect(html).toContain('<blockquote>I paged myself at 2am.</blockquote>');
  });

  it('carries the sentence saying the quotes were typed, not recorded', () => {
    const html = render({
      ...BASE,
      evidenceEntries: [{ competencyId: 'c1', competencyName: 'Incident response', claim: 'Owned it.', quote: 'I ran it.' }],
      evidence: { kind: 'structured', label: 'Claims with quotes, by competency', detail: 'The quotes were typed by the interviewer, not a recording of it.' },
    });

    expect(html).toContain('not a recording of it');
  });

  it('withholds the quotes along with the prose', () => {
    const html = render({
      ...BASE,
      notesWithheld: 'Another interviewer’s record stays closed until the team has decided.',
      evidenceEntries: [],
    });

    expect(html).not.toContain('blockquote');
  });
});
