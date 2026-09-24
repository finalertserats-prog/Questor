// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { CompetencyRow } from '../src/components/scorecard/CompetencyRow';
import { NO_SPAN_NOTE } from '../src/components/scorecard/competencySourceModel';
import type { EditableCompetency } from '../src/components/scorecard/competencyEditModel';

/**
 * The row is where a reviewer decides whether a competency belongs on the
 * scorecard at all, so what is asserted here is that it can never be read
 * without its evidence — or, where there is none, without being told so.
 */

afterEach(cleanup);

const noop = () => undefined;

function row(patch: Partial<EditableCompetency> = {}) {
  const competency: EditableCompetency = {
    id: 'c1',
    name: 'SQL & Data Warehousing',
    definition: '',
    category: 'technical',
    classification: 'essential',
    weight: 0.4,
    requiredLevel: 3,
    targetLevel: 4,
    indicators: [],
    ...patch,
  };
  return render(h('table', null, h('tbody', null, h(CompetencyRow, {
    competency, mustPass: false, hasHistory: false, locked: false,
    onPatch: noop, onMustPass: noop, onRemove: noop,
  }))));
}

describe('CompetencyRow provenance', () => {
  it('quotes the job description line the competency was read from', () => {
    row({ source: { text: '5+ years of SQL and dimensional warehousing.', line: 18, section: 'requirements' } });

    expect(screen.getByTestId('competency-source-c1').textContent).toContain('5+ years of SQL and dimensional warehousing.');
  });

  it('says which section of the advert the line came from, and where', () => {
    row({ source: { text: 'Owns the reporting layer.', line: 7, section: 'responsibilities' } });

    expect(screen.getByTestId('competency-source-c1').textContent).toContain('Responsibilities, line 7');
  });

  it('says a baseline competency is asked on every role, not taken from this advert', () => {
    row({ origin: 'baseline' });

    expect(screen.getByTestId('competency-no-source-c1').textContent).toBe('Asked on every role, not taken from this advert.');
  });

  it('admits when an older record kept no source line, instead of showing an empty quote', () => {
    const { container } = row();

    expect(screen.getByTestId('competency-no-source-c1').textContent).toBe(NO_SPAN_NOTE);
    expect(container.querySelector('q')).toBeNull();
  });

  it('marks a low-confidence competency as uncertain', () => {
    row({ source: { text: 'Some Kafka would be handy.', line: 30, section: 'nice_to_have' }, lowConfidence: true });

    expect(screen.getByTestId('competency-uncertain-c1').textContent).toBe('uncertain');
    expect(screen.getByTestId('competency-source-c1').className).toContain('is-uncertain');
  });

  it('leaves a confident competency unmarked', () => {
    row({ source: { text: 'Strong SQL.', line: 2, section: 'requirements' } });

    expect(screen.queryByTestId('competency-uncertain-c1')).toBeNull();
  });

  it('shows the rationale on the page, not behind a link to somewhere else', () => {
    row({ origin: 'baseline', rationale: 'Asked on every role by the platform. Remove it if this job genuinely does not need it.' });

    expect(screen.getByTestId('competency-source-c1').textContent).toContain('Remove it if this job genuinely does not need it.');
  });

  it('offers removal as a single button, with no step before it', () => {
    const onRemove = vi.fn();
    const competency: EditableCompetency = {
      id: 'c1', name: 'Kafka', definition: '', category: 'technical', classification: 'preferred',
      weight: 0.2, requiredLevel: 2, targetLevel: 3, indicators: [],
    };
    render(h('table', null, h('tbody', null, h(CompetencyRow, {
      competency, mustPass: false, hasHistory: false, locked: false,
      onPatch: noop, onMustPass: noop, onRemove,
    }))));

    screen.getByTestId('competency-remove-c1').click();

    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
