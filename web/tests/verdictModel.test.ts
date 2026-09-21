import { describe, it, expect } from 'vitest';
import { verdictOf } from '../src/components/verdictModel';

describe('verdictOf', () => {
  it('shows the reviewer verdict over the AI one', () => {
    expect(verdictOf({ recommendation: 'PROCEED', humanRecommendation: 'DO_NOT_PROGRESS' }))
      .toEqual({ value: 'DO_NOT_PROGRESS', source: 'human', marker: '[ reviewer ]' });
  });

  it('shows the AI recommendation before anyone has reviewed', () => {
    expect(verdictOf({ recommendation: 'PROCEED', humanRecommendation: null }).source).toBe('ai');
  });

  it('shows the AI recommendation from an older server without the field', () => {
    expect(verdictOf({ recommendation: 'CONSIDER' }).value).toBe('CONSIDER');
  });

  it('shows nothing before an assessment exists', () => {
    expect(verdictOf({ recommendation: null, humanRecommendation: null })).toEqual({ value: null, source: null, marker: '' });
  });
});
