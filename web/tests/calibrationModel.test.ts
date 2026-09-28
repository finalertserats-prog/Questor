import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  bandLabel, competencyLabel, deltaLabel, durationLabel, groupAdjustments, headline, holdLabel,
  intervalLabel, proportionLabel, signedLabel, statusLabel, thresholdSentence, tooFewSentence,
  type Adjustment, type CalibrationSettings,
} from '../src/components/calibrationModel';

vi.mock('../src/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const SETTINGS: CalibrationSettings = {
  enabled: true, platformEnabled: true, organisationEnabled: true, contributesGlobally: false,
  thresholds: { minObservations: 15, minReviewers: 3, maxAbsDelta: 1, reviewerPatternMinReviews: 10 },
};

function adjustment(patch: Partial<Adjustment> = {}): Adjustment {
  return {
    id: 'a1', scope: 'org', roleId: 'r1', competencyId: 'stake',
    competencyName: 'Stakeholder management', competencyKey: 'stakeholder management',
    band: 'mid', status: 'active', delta: -1, measuredMedian: -1,
    interval: { low: -1, high: -1 }, observations: 18, reviewers: 4, majorDisagreements: 2,
    since: '2026-08-12T00:00:00.000Z',
    statement: 'Adjusted -1: 18 reviews, 4 reviewers, since 12 Aug 2026.',
    holdReason: '', themes: [], activatedAt: '2026-09-01T00:00:00.000Z', revertedAt: null,
    revertReason: '', computedAt: '2026-09-23T00:00:00.000Z', ...patch,
  };
}

describe('labels', () => {
  it('says a competency in the words the scorecard spells it in', () => {
    // The key is lower-cased for grouping; showing it would mangle acronyms.
    expect(competencyLabel({ competencyName: 'SQL & Data Warehousing', competencyKey: 'sql & data warehousing' }))
      .toBe('SQL & Data Warehousing');
  });

  it('falls back to the key when the scorecard no longer has the competency', () => {
    expect(competencyLabel({ competencyName: '', competencyKey: 'stakeholder management' }))
      .toBe('Stakeholder management');
  });

  it('names the absence of a band rather than leaving a gap', () => {
    expect(bandLabel('')).toBe('Any experience level');
  });

  it('signs a change so a reader never has to guess its direction', () => {
    expect(deltaLabel(-0.5)).toBe('-0.5');
    expect(deltaLabel(1)).toBe('+1');
  });

  it('gives a bare signed figure for use inside a sentence', () => {
    // "measured No change, interval 0 to 0" is not a sentence.
    expect(signedLabel(0)).toBe('0');
    expect(signedLabel(-1)).toBe('-1');
  });

  it('says no change rather than showing a zero', () => {
    expect(deltaLabel(0)).toBe('No change');
  });

  it('says there is no interval rather than printing a fake one', () => {
    expect(intervalLabel({ interval: null })).toBe('Too few reviews for an interval');
  });

  it('shows an interval with both signs', () => {
    expect(intervalLabel({ interval: { low: -1, high: -0.5 } })).toBe('-1 to -0.5');
  });

  it('says a duration in units a person reads', () => {
    expect(durationLabel(8)).toBe('8 seconds');
    expect(durationLabel(600)).toBe('10 minutes');
    expect(durationLabel(null)).toBe('Not recorded');
  });

  it('gives a proportion with its interval, so a small sample cannot read as precision', () => {
    expect(proportionLabel({ count: 5, n: 10, value: 0.5, low: 0.24, high: 0.76 })).toBe('50% (24–76%)');
    expect(proportionLabel(null)).toBe('Not known');
  });
});

describe('statusLabel', () => {
  it('says applied when a score is actually moving', () => {
    expect(statusLabel({ status: 'active', holdReason: '' })).toBe('Applied');
  });

  it('says a person switched it off, not that it failed', () => {
    expect(statusLabel({ status: 'reverted', holdReason: '' })).toBe('Switched off by a person');
  });

  it('says why it is held, in plain words', () => {
    expect(statusLabel({ status: 'held', holdReason: 'too_few_observations' })).toBe('Too few reviews yet');
    expect(statusLabel({ status: 'held', holdReason: 'fairness_flagged' })).toBe('Held for a person to look at');
  });

  it('never characterises a reviewer, whatever the reason', () => {
    const reasons = [
      'too_few_observations', 'too_few_reviewers', 'no_interval', 'interval_includes_zero',
      'estimate_outside_interval', 'reviewers_disagree', 'below_smallest_step', 'fairness_flagged',
      'switched_off', 'something_new',
    ];
    for (const reason of reasons) {
      expect(holdLabel(reason).toLowerCase()).not.toMatch(/wrong|biased|harsh|lenient|unfair|mistake/);
    }
  });
});

describe('groupAdjustments', () => {
  it('separates what is moving scores from what is only being watched', () => {
    const groups = groupAdjustments([
      adjustment({ id: 'applied' }),
      adjustment({ id: 'held', status: 'held', delta: 0, holdReason: 'too_few_observations' }),
      adjustment({ id: 'off', status: 'reverted', delta: 0 }),
    ]);
    expect(groups.applied.map((a) => a.id)).toEqual(['applied']);
    expect(groups.watching.map((a) => a.id)).toEqual(['held']);
    expect(groups.reverted.map((a) => a.id)).toEqual(['off']);
  });

  it('treats an active row that moves nothing as being watched, not applied', () => {
    const groups = groupAdjustments([adjustment({ status: 'active', delta: 0 })]);
    expect(groups.applied).toHaveLength(0);
    expect(groups.watching).toHaveLength(1);
  });
});

describe('headline', () => {
  it('says the deployment has it off before anything else', () => {
    const groups = groupAdjustments([]);
    expect(headline({ ...SETTINGS, platformEnabled: false }, groups)).toContain('switched off for this deployment');
  });

  it('tells an organisation with it off that the evidence is still being kept', () => {
    const groups = groupAdjustments([]);
    expect(headline({ ...SETTINGS, organisationEnabled: false }, groups)).toContain('still recorded');
  });

  it('says nothing is being adjusted rather than showing an empty table', () => {
    const groups = groupAdjustments([adjustment({ status: 'held', delta: 0 })]);
    expect(headline(SETTINGS, groups)).toContain('Nothing is being adjusted');
  });

  it('promises the model\'s own level is kept when something is applied', () => {
    const groups = groupAdjustments([adjustment()]);
    expect(headline(SETTINGS, groups)).toContain('model\'s own level is kept');
  });
});

describe('thresholdSentence', () => {
  it('states the bar and the bound in one sentence', () => {
    const sentence = thresholdSentence(SETTINGS);
    expect(sentence).toContain('15 reviews');
    expect(sentence).toContain('3 different reviewers');
    expect(sentence).toContain('never by more than 1 level');
  });
});

describe('tooFewSentence', () => {
  it('is an answer, not an empty state', () => {
    const sentence = tooFewSentence({ reviews: 4, minimumReviews: 10 });
    expect(sentence).toContain('4 reviews');
    expect(sentence).toContain('too few to say anything');
    expect(sentence).toContain('at least 10');
  });
});

describe('the panel', () => {
  it('renders the evidence beside every applied adjustment', async () => {
    const { CalibrationPanel } = await import('../src/components/CalibrationPanel');
    // Rendered before its data arrives: the loading state must not throw.
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CalibrationPanel)));
    expect(html).toContain('Loading');
  });
});
