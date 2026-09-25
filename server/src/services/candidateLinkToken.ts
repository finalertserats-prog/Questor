import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../middleware/index.js';

/**
 * The one token scheme for single-purpose links mailed to a candidate after
 * their interview: "would you like to speak to a person?" and "would you like
 * written feedback?".
 *
 * Deliberately NOT the interview token. That one is consumed when the interview
 * finishes, it opens a portal that reads the candidate's own data, and it is
 * the credential for a surface that costs money per call. A link mailed out
 * afterwards needs none of that reach, so it gets none of it. Each link lives
 * in its own table, so a token for one purpose is unknown to the other.
 */

export const DAY_MS = 24 * 60 * 60_000;

/**
 * 256 bits from the CSPRNG, base64url so it survives being pasted out of a mail
 * client. Unguessable is the whole access control here: there is no second
 * factor and no login behind it.
 */
export function mintCandidateLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only the hash is stored. The link lives in the candidate's mailbox; a leaked
 * database backup or an over-broad support query should not also hand over a
 * working one. It is a high-entropy random value rather than a password, so a
 * single SHA-256 is the right primitive — there is nothing to brute-force.
 */
export function hashCandidateLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Rejects anything that is not shaped like one of our tokens before it reaches the database. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,128}$/;

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Look a link up by its hash. 404 for anything we did not issue, 410 once it
 * has aged out. Callers return nothing else about the row to the browser: the
 * token is not allowed to be a way of reading about a person.
 */
export async function resolveCandidateLink<T extends { tokenHash: string; expiresAt: Date }>(opts: {
  token: string;
  findByHash: (tokenHash: string) => Promise<T | null>;
  expiredMessage: string;
  now?: Date;
}): Promise<T> {
  if (!TOKEN_SHAPE.test(opts.token)) throw new HttpError(404, 'This link is not valid.');

  const tokenHash = hashCandidateLinkToken(opts.token);
  const row = await opts.findByHash(tokenHash);
  if (!row || !hashesMatch(row.tokenHash, tokenHash)) throw new HttpError(404, 'This link is not valid.');
  if (row.expiresAt <= (opts.now ?? new Date())) throw new HttpError(410, opts.expiredMessage);
  return row;
}
