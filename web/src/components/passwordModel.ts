import { PASSWORD_MIN_LENGTH } from './signupModel';

/**
 * The rules behind setting a password, kept free of React so they can be unit
 * tested in the node environment this workspace uses.
 *
 * The length floor is imported from signupModel rather than written again: the
 * server holds one policy (server/src/domain/passwordPolicy.ts) and the two
 * workspaces do not share code, so there is exactly one copy on each side and
 * they must move together. A recovery form that accepted a weaker password than
 * the signup form would make recovery the soft way in.
 */
export { PASSWORD_MIN_LENGTH };

/** Said before the field, not after a rejection. */
export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters. Length is worth more here than punctuation.`;

/** bcrypt reads the first 72 bytes and silently ignores the rest. */
const MAX_BYTES = 72;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** One sentence naming what is wrong with a new password, or null. */
export function newPasswordProblem(password: string, confirmation?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Please use a password of at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (byteLength(password) > MAX_BYTES) return 'That password is too long. Please use something shorter.';
  if (confirmation !== undefined && password !== confirmation) return 'The two passwords do not match.';
  return null;
}

/** Enough of an address to be worth sending; the server is the real judge. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function forgotFormProblem(email: string): string | null {
  return EMAIL_SHAPE.test(email.trim()) ? null : 'Please enter the email address you sign in with.';
}

/**
 * The reset token out of the address bar.
 *
 * It arrives in the fragment (`/reset-password#<token>`), never in the path or
 * the query, because a fragment is the one part of a URL a browser does not
 * send to the server — so the token is not written into an access log, a proxy
 * log or a Referer header on the way in. The page reads it here and puts it in
 * a request body instead.
 */
export function tokenFromHash(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  // Tolerate `#token=…` as well as a bare `#…`: a mail client that rewrites
  // links has been known to normalise one into the other.
  const value = raw.startsWith('token=') ? raw.slice('token='.length) : raw;
  return /^[A-Za-z0-9_-]{16,256}$/.test(value) ? value : '';
}

/**
 * What the confirmation says. Deliberately the same sentence whether or not the
 * address has an account: the page cannot be used to ask who works somewhere.
 */
export const FORGOT_SENT_MESSAGE =
  'If that address has a Questor account, a link to set a new password is on its way. It works once and expires in an hour. Check your spam folder if it has not arrived in a few minutes.';

/** What a dead link says. The same for expired, used and never-issued. */
export const LINK_DEAD_MESSAGE = 'This link is no longer valid. It may have expired, already been used, or been replaced by a newer one. Ask for a new link from the sign-in page.';
