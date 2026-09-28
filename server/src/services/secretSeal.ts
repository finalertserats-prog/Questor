import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Stored credentials, sealed under AUTH_SECRET the same way invitation links
 * are (services/invitations.ts): AES-256-GCM with a key derived per purpose, so
 * a value sealed for one use cannot be opened as another. Only the running
 * application, holding the secret, can open a sealed value; a database dump or
 * backup alone gives nothing away. Rotating AUTH_SECRET makes every sealed
 * value unopenable, which for an ATS key means the admin enters it again.
 */

export type SealPurpose = 'ats-credential';

function sealingKey(purpose: SealPurpose): Buffer {
  return createHash('sha256').update(`questor-${purpose}-seal:${config.authSecret}`).digest();
}

/** Format: v1.<iv>.<tag>.<ciphertext>, base64url. */
export function sealSecret(purpose: SealPurpose, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** The value back, or null if it is missing, malformed, or sealed under another key. */
export function openSecret(purpose: SealPurpose, sealed: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(purpose), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
