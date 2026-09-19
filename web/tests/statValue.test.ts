import { describe, it, expect } from 'vitest';
import { isTextStatValue } from '../src/components/scoreFormat';

describe('isTextStatValue', () => {
  it('keeps a number at figure size', () => {
    expect(isTextStatValue(42)).toBe(false);
  });

  it('keeps a formatted figure at figure size', () => {
    expect(isTextStatValue('72%')).toBe(false);
  });

  it('keeps the missing-value dash at figure size', () => {
    expect(isTextStatValue('—')).toBe(false);
  });

  it('sets an email address as text', () => {
    expect(isTextStatValue('priya.raman@example.com')).toBe(true);
  });

  it('sets a role name as text', () => {
    expect(isTextStatValue('Senior Backend Engineer · Senior')).toBe(true);
  });
});
