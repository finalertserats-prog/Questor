import { config } from '../config.js';

// The server-side pepper that one-time secrets are keyed under before they are
// stored.
//
// Written for the identity codes candidates enter (services/identityCode.ts)
// and lifted here unchanged when password-reset links needed exactly the same
// property: the stored value must be useless to anyone holding a copy of the
// database, so the database never holds the secret itself — only an HMAC under
// a key that lives in the environment.
//
// One pepper serves both because each caller prefixes its own purpose string
// into the HMAC input (`identity-code:v1:…`, `password-reset:v1:…`), so a hash
// from one feature can never be replayed against the other. A second
// environment variable would have been a second thing to set correctly on every
// deployment, and the failure mode of getting it wrong is silent.

/** Outside production only, so the zero-setup build still works. */
const DEV_PEPPER = 'questor-development-identity-code-pepper';

/**
 * The configured pepper.
 *
 * Fails closed in production: with no pepper set we would be storing secrets
 * under a value an attacker already knows, which is worse than the feature not
 * working. Preflight refuses to boot production without it for the same reason,
 * so this throw is the backstop rather than the first line.
 */
export function serverPepper(
  env: { nodeEnv: string; pepper: string } = { nodeEnv: config.nodeEnv, pepper: config.identityCodePepper },
): string {
  const pepper = env.pepper.trim();
  if (pepper) return pepper;
  if (env.nodeEnv === 'production') {
    throw new Error('IDENTITY_CODE_PEPPER is not set; refusing to issue or check one-time secrets.');
  }
  return DEV_PEPPER;
}
