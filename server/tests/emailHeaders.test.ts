import { describe, it, expect } from 'vitest';
import { headerSafe } from '../src/providers/email/branding.js';

/**
 * Mail headers are single lines. Names and role titles typed by people reach
 * subject lines in three places; every one goes through this.
 */
describe('headerSafe', () => {
  it('collapses a carriage return and line feed into spaces', () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);

    const out = headerSafe(`Senior Engineer${CR}${LF}Bcc: someone@example.com`);

    expect(out.includes(CR) || out.includes(LF)).toBe(false);
  });

  it('leaves ordinary punctuation and accents alone', () => {
    expect(headerSafe('Ingénieur — données (Paris)')).toBe('Ingénieur — données (Paris)');
  });

  it('bounds the length', () => {
    expect(headerSafe('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it('trims surrounding whitespace', () => {
    expect(headerSafe('  Data Engineer  ')).toBe('Data Engineer');
  });
});
