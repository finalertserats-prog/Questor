import { startJob } from './jobs.js';
import { purgeEndedResetTokens } from './passwordReset.js';
import { purgeEndedSignInChallenges } from './signInCode.js';
import { purgeEndedTrustedDevices } from './trustedDevice.js';

/**
 * Sweep away the one-time credentials that have ended.
 *
 * Spent and expired reset links, spent and expired sign-in codes, and device
 * grants that were revoked or ran out. None of the rows holds anything that can
 * be turned back into a secret — each is an HMAC under the server pepper — but
 * two things make this worth a job rather than a comment:
 *
 *  - a trusted-device row keeps the rough origin of its last use, which is
 *    personal data with no reason to outlive the grant;
 *  - one row per sign-in, kept for ever, is a table that is fine until the day
 *    somebody has to query it.
 *
 * Under a lease with the other jobs, so one instance does it. Hourly: none of
 * this is urgent, and a sweep that runs while people are signing in should be
 * rare enough not to matter.
 */
export const CREDENTIAL_PURGE_EVERY_MS = 60 * 60_000;

export function startCredentialPurge(intervalMs = CREDENTIAL_PURGE_EVERY_MS): () => void {
  return startJob({
    name: 'credential-purge',
    intervalMs,
    delayFirst: true,
    fn: async () => {
      const [links, codes, devices] = await Promise.all([
        purgeEndedResetTokens(),
        purgeEndedSignInChallenges(),
        purgeEndedTrustedDevices(),
      ]);
      return `purged ${links} ended reset links, ${codes} ended sign-in codes and ${devices} ended device grants`;
    },
  });
}
