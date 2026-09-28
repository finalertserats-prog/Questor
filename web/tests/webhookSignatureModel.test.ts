import { describe, it, expect } from 'vitest';
import {
  LEGACY_OFF_CONFIRMATION, eventsForApi, eventsLabel, signatureView,
} from '../src/components/webhookSignatureModel';

describe('signatureView', () => {
  it('offers to switch v1 off for a webhook that still sends it', () => {
    expect(signatureView({ sendLegacySignature: true }, false)).toMatchObject({
      label: 'v2 and legacy v1', canSwitchOff: true, canSwitchOn: false,
    });
  });

  it('shows a v2-only webhook as done, with a way back for a receiver that broke', () => {
    expect(signatureView({ sendLegacySignature: false }, false)).toMatchObject({
      label: 'v2 only', canSwitchOff: false, canSwitchOn: true,
    });
  });

  it('shows every webhook as v2-only while the operator switch is off, and offers nothing', () => {
    expect(signatureView({ sendLegacySignature: true }, true)).toMatchObject({
      label: 'v2 only (v1 is off for every webhook)', canSwitchOff: false, canSwitchOn: false,
    });
  });
});

describe('the confirmation before switching v1 off', () => {
  it('says the receiver must already verify v2', () => {
    expect(LEGACY_OFF_CONFIRMATION).toMatch(/x-questor-signature-v2/);
  });

  it('names the timestamp header the receiver has to check', () => {
    expect(LEGACY_OFF_CONFIRMATION).toMatch(/x-questor-timestamp/);
  });
});

describe('events', () => {
  // The server stores and returns a comma-separated string. The console used to
  // treat it as an array and failed to render as soon as one webhook existed.
  it('reads the stored comma-separated list', () => {
    expect(eventsLabel('assessment.ready,feedback.sent')).toBe('assessment.ready, feedback.sent');
  });

  it('shows "all events" for the wildcard', () => {
    expect(eventsLabel('*')).toBe('All events');
  });

  it('sends the typed list as the string the server expects', () => {
    expect(eventsForApi(' assessment.ready , ,feedback.sent ')).toBe('assessment.ready,feedback.sent');
  });

  it('falls back to every event when nothing was typed', () => {
    expect(eventsForApi('  ')).toBe('*');
  });
});
