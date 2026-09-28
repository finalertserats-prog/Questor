/**
 * What the Admin console says about each webhook's signatures.
 *
 * Deliveries always carry the timestamped v2 signature. Webhooks that existed
 * before v2-only became the default also carry the original v1 header until an
 * admin switches it off here, or the operator switches it off everywhere with
 * WEBHOOK_V1_SIGNATURE=off (see docs/RUNBOOK.md).
 */

export interface WebhookSignatureFields {
  readonly sendLegacySignature: boolean;
}

export interface SignatureView {
  readonly label: string;
  readonly canSwitchOff: boolean;
  readonly canSwitchOn: boolean;
}

export function signatureView(hook: WebhookSignatureFields, disabledEverywhere: boolean): SignatureView {
  // The per-webhook setting cannot do anything while the operator's switch is
  // off, so offering to change it would be a button that changes nothing.
  if (disabledEverywhere) {
    return { label: 'v2 only (v1 is off for every webhook)', canSwitchOff: false, canSwitchOn: false };
  }
  if (hook.sendLegacySignature) {
    return { label: 'v2 and legacy v1', canSwitchOff: true, canSwitchOn: false };
  }
  // Switching back on is kept for the receiver that turns out not to verify v2
  // yet. It is the quickest way to stop its deliveries failing.
  return { label: 'v2 only', canSwitchOff: false, canSwitchOn: true };
}

/** Shown before v1 is switched off, because a receiver still checking v1 breaks at once. */
export const LEGACY_OFF_CONFIRMATION = 'Only do this once this receiver verifies the v2 signature. '
  + 'From the next delivery it will no longer get the old x-questor-signature header. It must check '
  + 'x-questor-signature-v2, an HMAC-SHA256 of "<x-questor-timestamp>.<body>" with the signing secret, '
  + 'and refuse deliveries whose x-questor-timestamp is more than 5 minutes old. '
  + 'A receiver that still checks v1 will reject every delivery. You can switch v1 back on here.';

export function eventsLabel(stored: string): string {
  const events = stored.split(',').map((e) => e.trim()).filter(Boolean);
  if (events.length === 0 || events.includes('*')) return 'All events';
  return events.join(', ');
}

export function eventsForApi(typed: string): string {
  const events = typed.split(',').map((e) => e.trim()).filter(Boolean);
  return events.length ? events.join(',') : '*';
}
