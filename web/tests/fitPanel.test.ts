// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FitPanel } from '../src/components/fit/FitPanel';
import { FIT_CAVEAT } from '../src/components/fit/fitVocabulary';
import type { Fit } from '../src/components/fit/fitModel';

/**
 * The fit panel's job is to make a number arguable.
 *
 * So the assertions are about whether a reader can see what the reading was
 * built from, whether silence is described as silence, and whether the panel
 * keeps saying it is not a decision.
 */

afterEach(cleanup);

const evidence = (quote: string, line = 4) => ({ line, quote, section: 'experience' });

const FIT: Fit = {
  overall: 78,
  confidence: 0.72,
  coverage: 0.8,
  band: 'strong_match',
  meaning: 'The CV evidences most of what this role asks for, including its must-haves.',
  components: [
    { key: 'must_haves', label: 'Must-haves met', weight: 0.33, score: 100, evidence: [], rule: 'A must-have the CV does not evidence is named.', explanation: '1 of 1 must-haves are evidenced on the CV.' },
    { key: 'competencies', label: 'Scorecard competencies', weight: 0.3, score: 74, evidence: [], rule: 'Weighted as the scorecard weights it.', explanation: '2 of 3 competencies are evidenced.' },
  ],
  missing: ['Mentoring'],
  probes: ['Probe Mentoring: the CV is silent on Mentoring.'],
  probeDetail: [{ text: 'Probe Mentoring: the CV is silent on Mentoring.', reason: 'Essential competency the CV does not mention.' }],
  excludedSignals: ['name', 'age', 'graduation year'],
  competencies: [
    { competencyId: 'c1', name: 'Pipeline Engineering', classification: 'essential', mustHave: true, strength: 'evidenced', score: 85, evidence: [evidence('Owned the streaming ingestion in Kafka.')], explanation: 'Pipeline Engineering is evidenced in work the CV describes doing, across 1 line.' },
    { competencyId: 'c2', name: 'Dimensional Modelling', classification: 'essential', mustHave: false, strength: 'partial', score: 60, evidence: [evidence('Star schema design.', 9)], explanation: 'Dimensional Modelling appears on the CV, but only once.' },
    { competencyId: 'c3', name: 'Mentoring', classification: 'preferred', mustHave: false, strength: 'not_evidenced', score: null, evidence: [], explanation: 'The CV does not mention Mentoring. That is silence, not a shortfall — the interview is where it gets checked.' },
  ],
  technologies: [
    { name: 'Kafka', required: true, level: 'strong', strength: 'evidenced', recencyYears: 0, monthsUsed: 30, evidence: [evidence('Owned the streaming ingestion in Kafka.')], explanation: 'Kafka is required by this role and the CV shows it in current or recent work.' },
  ],
  mustHaveGaps: [],
  niceToHavesPresent: ['Terraform'],
  notEvidenced: ['Mentoring'],
  redaction: { linesRemoved: 5, kinds: ['name', 'date_of_birth'], injectionLines: [] },
};

const panel = (over: Partial<Fit> = {}, rescoredNote: string | null = null) =>
  render(h(FitPanel, { fit: { ...FIT, ...over }, rescoredNote }));

describe('the reading at the top', () => {
  it('leads with a word, not a number', () => {
    panel();
    expect(screen.getByTestId('fit-band').textContent).toBe('Strong evidence of fit');
  });

  it('says what that word means', () => {
    panel();
    expect(screen.getByTestId('fit-meaning').textContent).toContain('evidences most of what this role asks for');
  });

  it('shows how much of the scorecard the CV even speaks to, next to the score', () => {
    panel();
    expect(screen.getByTestId('fit-overall').textContent).toContain('78');
    expect(screen.getByTestId('fit-coverage').textContent).toBe('80%');
  });

  it('never borrows the interview verdict\'s words', () => {
    const { container } = panel();
    const text = container.textContent!.toLowerCase();
    for (const word of ['proceed', 'do not progress', 'reject']) expect(text).not.toContain(word);
  });
});

describe('the caveats', () => {
  it('say fit is a screening aid, not a decision', () => {
    const { container } = panel();
    expect(container.textContent).toContain(FIT_CAVEAT);
  });

  it('say a candidate never sees this', () => {
    const { container } = panel();
    expect(container.textContent).toContain('A candidate is never shown their fit score.');
  });
});

describe('strengths', () => {
  it('quote the CV line each one was read from', () => {
    panel();
    const row = screen.getByTestId('fit-competency-c1');
    expect(row.textContent).toContain('Owned the streaming ingestion in Kafka.');
  });

  it('say where on the CV the line was', () => {
    panel();
    expect(screen.getByTestId('fit-competency-c1').textContent).toContain('CV line 5');
  });

  it('separate what is claimed once from what is shown', () => {
    panel();
    expect(screen.getByTestId('fit-competency-c2').textContent).toContain('Thinly evidenced');
  });
});

describe('what the CV does not say', () => {
  it('is described as silence rather than as a shortfall', () => {
    panel();
    expect(screen.getByTestId('fit-silent').textContent).toContain('carried as unknown, not as zero');
  });

  it('names a must-have gap separately when there is one', () => {
    panel({ mustHaveGaps: ['Pipeline Engineering'] });
    expect(screen.getByTestId('fit-must-haves').textContent).toContain('Pipeline Engineering');
  });

  it('shows no must-have block when nothing is missing', () => {
    panel();
    expect(screen.queryByTestId('fit-must-haves')).toBeNull();
  });
});

describe('what the interview will probe', () => {
  it('lists the probes with the reason each is worth asking', () => {
    panel();
    const probes = screen.getByTestId('fit-probes');
    expect(probes.textContent).toContain('Probe Mentoring');
    expect(probes.textContent).toContain('Essential competency the CV does not mention.');
  });

  it('says they reach the interview plan', () => {
    panel();
    expect(screen.getByTestId('fit-probes').textContent).toContain('reach the interview plan');
  });
});

describe('the arithmetic', () => {
  it('is folded away until asked for', () => {
    panel();
    expect(screen.getByTestId('fit-components').textContent).not.toContain('Must-haves met');
  });

  it('opens to show each part with its own sentence', () => {
    panel();
    fireEvent.click(screen.getByRole('button', { name: /how the overall number was reached/i }));
    expect(screen.getByTestId('fit-components').textContent).toContain('1 of 1 must-haves are evidenced');
  });
});

describe('what was not read', () => {
  it('comes from the server rather than from a copy in the page', () => {
    panel({ excludedSignals: ['name', 'shoe size'] });
    expect(screen.getByTestId('fit-excluded').textContent).toContain('shoe size');
  });

  it('says the removed lines were never read', () => {
    panel();
    expect(screen.getByTestId('fit-redaction').textContent).toContain('never read');
  });

  it('warns loudly when the CV tried to instruct the system', () => {
    panel({ redaction: { linesRemoved: 1, kinds: [], injectionLines: [3, 4] } });
    expect(screen.getByTestId('fit-redaction').textContent).toContain('a person should look at this CV');
  });
});

describe('gaps and short tenures', () => {
  it('are shown when there are any', () => {
    panel({ tenureNote: 'There is a gap between dated roles.' });
    expect(screen.getByTestId('fit-tenure').textContent).toContain('There is a gap between dated roles.');
  });

  it('are said not to move the score', () => {
    panel({ tenureNote: 'There is a gap between dated roles.' });
    expect(screen.getByTestId('fit-tenure').textContent).toContain('Neither gaps nor short tenures move the score.');
  });

  it('are absent rather than reassuring when there are none', () => {
    panel();
    expect(screen.queryByTestId('fit-tenure')).toBeNull();
  });
});

describe('a re-scored reading', () => {
  it('says why it was re-scored', () => {
    const { container } = panel({}, 'Re-scored just now because the role moved from scorecard v2 to v3.');
    expect(container.textContent).toContain('the role moved from scorecard v2 to v3');
  });
});

describe('a fit stored by the old engine', () => {
  it('is shown, and said to be old', () => {
    render(h(FitPanel, { fit: { overall: 61, confidence: 0.5, components: [], missing: ['SQL'], probes: [] } as Fit }));
    expect(screen.getByTestId('fit-panel-legacy').textContent).toContain('earlier version of the fit engine');
  });
});

describe('no resume yet', () => {
  it('says so instead of showing a zero', () => {
    const { container } = render(h(FitPanel, { fit: null }));
    expect(container.textContent).toContain('No resume fit is available');
  });
});
