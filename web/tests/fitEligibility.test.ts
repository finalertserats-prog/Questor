// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { FitPanel } from '../src/components/fit/FitPanel';
import type { Fit } from '../src/components/fit/fitModel';

/**
 * Eligibility is the one block on this panel that is not a reading of the
 * candidate at all — it is a list of jobs for the person looking at the screen.
 *
 * So the assertions are about ownership and about wording. The block has to
 * quote the advert, quote the CV where there is anything to quote, say plainly
 * that a blank means Questor saw nothing rather than that the candidate has
 * nothing, and hand the decision to the reader in words they cannot misread.
 */

afterEach(cleanup);

const BASE: Fit = {
  overall: 71,
  confidence: 0.6,
  coverage: 0.7,
  band: 'some_evidence',
  components: [
    { key: 'must_haves', label: 'Must-haves met', weight: 0.33, score: 100, evidence: [], rule: 'A must-have the CV does not evidence is named.' },
  ],
  missing: [],
  probes: [],
  excludedSignals: [],
  competencies: [
    { competencyId: 'c1', name: 'Clinical & Patient Care', classification: 'essential', mustHave: true, strength: 'evidenced', score: 85, evidence: [{ line: 4, quote: 'Ran a nurse-led clinic.', section: 'experience' }], explanation: 'Evidenced across 1 line.' },
  ],
  eligibility: [
    {
      id: 'elig-12', kind: 'registration', line: 12,
      requirement: 'Current NMC registration with an active licence to practise is required.',
      evidence: [{ line: 9, quote: 'NMC registration, active.', section: 'certifications' }],
      note: 'One line of the CV mentions this. Whether it actually meets what the advert asks for is a judgement, and it is yours to make.',
    },
    {
      id: 'elig-14', kind: 'right_to_work', line: 14,
      requirement: 'Applicants must have the right to work in the United Kingdom.',
      evidence: [],
      note: 'Nothing on this CV mentions this. That is Questor finding no mention of it, which is not evidence that the candidate does not hold it — credentials are left off CVs all the time. Ask them, and record what they say.',
    },
  ],
};

const panel = (over: Partial<Fit> = {}) => render(h(FitPanel, { fit: { ...BASE, ...over } }));

describe('the eligibility block', () => {
  it('quotes the advert line that asked for it', () => {
    panel();
    expect(screen.getByTestId('fit-eligibility').textContent).toContain('Current NMC registration');
  });

  it('says which line of the advert, so the claim can be checked', () => {
    panel();
    expect(screen.getByTestId('fit-eligibility').textContent).toContain('Job description line 12');
  });

  it('quotes the CV where the CV says something', () => {
    panel();
    expect(screen.getByTestId('fit-eligibility-elig-12').textContent).toContain('NMC registration, active.');
  });

  it('describes a blank as Questor seeing nothing, not as the candidate lacking it', () => {
    panel();
    const row = screen.getByTestId('fit-eligibility-elig-14').textContent!;
    expect(row).toContain('not evidence that the candidate does not hold it');
    expect(row.toLowerCase()).not.toMatch(/\b(lacks|ineligible|unqualified|fails)\b/);
  });

  it('says out loud that no score was moved and no one was filtered', () => {
    panel();
    const block = screen.getByTestId('fit-eligibility').textContent!;
    expect(block).toContain('None of this moved the score');
    expect(block).toContain('you');
  });

  it('is not shown at all when the role asks for no credential', () => {
    panel({ eligibility: [] });
    expect(screen.queryByTestId('fit-eligibility')).toBeNull();
  });

  it('is not shown for a reading stored before eligibility existed', () => {
    panel({ eligibility: undefined });
    expect(screen.queryByTestId('fit-eligibility')).toBeNull();
  });
});
