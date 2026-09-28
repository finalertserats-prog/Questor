import { describe, it, expect } from 'vitest';
import { humanise, roleStatus } from '../src/components/statusModel';

describe('roleStatus', () => {
  it('shows an archived role as neutral, not as an amber draft', () => {
    expect(roleStatus('archived').tone).toBe('neutral');
  });

  it('gives an archived role its own icon, not the draft one', () => {
    expect(roleStatus('archived').icon).not.toBe(roleStatus('draft').icon);
  });

  it('shows a draft role as on hold', () => {
    expect(roleStatus('draft').tone).toBe('hold');
  });

  it('shows an approved role as a pass', () => {
    expect(roleStatus('approved').tone).toBe('pass');
  });

  it('labels a status in sentence case', () => {
    expect(roleStatus('archived').label).toBe('Archived');
  });
});

describe('humanise', () => {
  it('turns an enum value into sentence case', () => {
    expect(humanise('HUMAN_REVIEWED')).toBe('Human reviewed');
  });

  it('turns a lower-case value into sentence case', () => {
    expect(humanise('recruiter')).toBe('Recruiter');
  });
});
