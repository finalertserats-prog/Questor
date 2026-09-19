import { describe, it, expect } from 'vitest';
import { canRequestDemoAgain, demoReasonText, isFinalDemoMinute } from '../src/components/demoModel';

describe('canRequestDemoAgain', () => {
  it('offers a new link for an expired one', () => {
    expect(canRequestDemoAgain('expired')).toBe(true);
  });

  it('offers a new link for a used one', () => {
    expect(canRequestDemoAgain('used')).toBe(true);
  });

  it('does not offer one for a link the server does not recognise', () => {
    expect(canRequestDemoAgain('unknown')).toBe(false);
  });
});

describe('demoReasonText', () => {
  it('says an expired link has expired', () => {
    expect(demoReasonText('expired')).toBe('This demo link has expired.');
  });

  it('says an unknown link is not valid', () => {
    expect(demoReasonText('unknown')).toBe('This demo link is not valid.');
  });
});

describe('isFinalDemoMinute', () => {
  it('is true inside the last minute', () => {
    expect(isFinalDemoMinute(59_000)).toBe(true);
  });

  it('is false with more than a minute left', () => {
    expect(isFinalDemoMinute(61_000)).toBe(false);
  });

  it('is false once the demo is over', () => {
    expect(isFinalDemoMinute(0)).toBe(false);
  });
});
