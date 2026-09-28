import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * The candidate's invitation link, and how it is stored.
 *
 * The token in the link is a bearer credential for a person's interview. It
 * used to sit in the database as plaintext, so a dump, a support query or a
 * screenshot of the admin console handed out working links. It is now kept two
 * ways, neither of them plaintext:
 *
 *   - `tokenHash`: SHA-256 of the token, unique, the only thing looked up. A
 *     leaked table gives nobody a link.
 *   - `tokenSealed`: the token encrypted under a key derived from AUTH_SECRET,
 *     so the application can still show a recruiter the link they need to
 *     paste into a chat, and a resend can reuse the link already in the
 *     candidate's inbox. Only the running application, holding the secret,
 *     can open it. This is the deliberate trade against hash-only storage,
 *     which would have made every link show-once and every resend a rotation.
 *
 * The signup-decision and human-request tokens are hash-only because nobody
 * ever needs to see them again; an invitation link is different.
 */

/** nanoid-style alphabet, 24 characters, as the links have always looked. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
export const INVITATION_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export function mintInvitationToken(): string {
  const bytes = randomBytes(24);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sealingKey(): Buffer {
  return createHash('sha256').update(`questor-invitation-seal:${config.authSecret}`).digest();
}

/** Encrypt a token for storage. Format: v1.<iv>.<tag>.<ciphertext>, base64url. */
export function sealInvitationToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** The token back, or null if the sealed value is missing, malformed or from another key. */
export function openInvitationToken(sealed: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Everything the two storage columns need for a fresh token. */
export function invitationSecretColumns(token: string): { tokenHash: string; tokenSealed: string } {
  return { tokenHash: hashInvitationToken(token), tokenSealed: sealInvitationToken(token) };
}

/** The link a recruiter may copy, rebuilt from storage; null if it cannot be opened. */
export function invitationLink(row: { tokenSealed: string }): string | null {
  const token = openInvitationToken(row.tokenSealed);
  return token ? `${config.webOrigin}/portal/${token}` : null;
}

/**
 * Find an invitation from the token in a link. Shape is checked before any
 * query; the lookup is by hash; the hash is compared in constant time even
 * though the database already matched it, so this reads like its siblings.
 */
export async function findInvitationByToken<T extends { tokenHash: string | null }>(
  token: string,
  find: (tokenHash: string) => Promise<T | null>,
): Promise<T | null> {
  if (!INVITATION_TOKEN_SHAPE.test(token)) return null;
  const tokenHash = hashInvitationToken(token);
  const row = await find(tokenHash);
  if (!row?.tokenHash) return null;
  const a = Buffer.from(row.tokenHash, 'utf8');
  const b = Buffer.from(tokenHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b) ? row : null;
}

/**
 * One-time migration of rows written before hashing existed: hash and seal the
 * plaintext, then clear it. Safe to run on every start; a no-op once done.
 * Links already in candidates' inboxes keep working, because the hash of the
 * token they hold is what is now looked up.
 */
export async function backfillInvitationSecrets(): Promise<number> {
  const rows = await prisma.invitation.findMany({ where: { token: { not: null } }, select: { id: true, token: true } });
  for (const row of rows) {
    if (!row.token) continue;
    await prisma.invitation.update({
      where: { id: row.id },
      data: { ...invitationSecretColumns(row.token), token: null },
    });
  }
  if (rows.length > 0) logger.info({ count: rows.length }, 'Invitation tokens moved out of plaintext storage');
  return rows.length;
}
