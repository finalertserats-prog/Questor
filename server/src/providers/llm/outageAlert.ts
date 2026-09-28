import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getEmail } from '../email/index.js';

/**
 * One email to the operator when the primary model starts refusing for credit
 * or authentication: the two failures nobody but the owner can fix.
 *
 * One per outage, not one per call: once sent, nothing more goes out until the
 * primary has answered again. A primary that flaps between working and failing
 * still sends at most one an hour.
 */

export type OutageReason = 'auth' | 'quota';

const MIN_GAP_MS = 60 * 60_000;

let alertedThisOutage = false;
let lastSentAt: number | null = null;

const REASON_TEXT: Record<OutageReason, { headline: string; action: string }> = {
  quota: {
    headline: 'is out of credit',
    action: 'Top up the account (or raise its spending limit). Interviews pick the primary up again on their own within minutes of it answering.',
  },
  auth: {
    headline: 'is refusing its API key',
    action: 'Check the key in the server environment (rotated, revoked or wrong project?), then restart the app.',
  },
};

/**
 * Fire and forget: never throws, never delays a candidate's turn. `servingNow`
 * says what interviews use meanwhile, so the owner knows how urgent it is.
 */
export async function alertLlmOutage(provider: string, reason: OutageReason, servingNow: string): Promise<void> {
  const to = config.signupApproverEmail.trim();
  if (!to || alertedThisOutage) return;
  const now = Date.now();
  if (lastSentAt !== null && now - lastSentAt < MIN_GAP_MS) return;
  // Claimed before the send so two turns failing together do not both email;
  // handed back when nothing went out, so the next failure tries again.
  const previous = lastSentAt;
  alertedThisOutage = true;
  lastSentAt = now;
  const release = () => {
    alertedThisOutage = false;
    lastSentAt = previous;
  };
  const email = getEmail();
  if (!email.delivers) {
    release();
    logger.error({ provider, reason }, 'Primary model outage: no email provider delivers, so the operator was not told');
    return;
  }
  const { headline, action } = REASON_TEXT[reason];
  const when = new Date(now).toISOString();
  const text =
    `The primary AI model (${provider}) ${headline} as of ${when}.\n\n` +
    `Interviews are now served by: ${servingNow}.\n\n` +
    `What to do: ${action}\n\n` +
    'Admin → System health shows which layer is serving interviews. This alert is sent once per outage.';
  try {
    await email.send({
      to,
      subject: `Questor: the AI model ${headline}`,
      text,
      html: text.split('\n\n').map((p) => `<p>${p.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c))}</p>`).join(''),
    });
  } catch (err) {
    release();
    logger.error({ provider, reason, err: err instanceof Error ? err.message : String(err) }, 'Could not send the model outage alert');
  }
}

/** The primary answered again: the next outage is a new one and gets its own email. */
export function noteLlmRecovered(): void {
  alertedThisOutage = false;
}

/** Test hook. */
export function _resetLlmOutageAlerts(): void {
  alertedThisOutage = false;
  lastSentAt = null;
}
