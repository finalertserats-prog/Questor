import { createHmac } from 'node:crypto';

export { hashResetToken } from '../../src/services/passwordReset.js';

/**
 * The same construction services/passwordReset.ts uses, with the pepper passed
 * in, so a test can show that two peppers give two different hashes without
 * reaching into the process's configuration to swap one.
 */
export function serverPepperProbe(pepper: string, token: string): string {
  return createHmac('sha256', pepper).update(`password-reset:v1:${token}`).digest('hex');
}
