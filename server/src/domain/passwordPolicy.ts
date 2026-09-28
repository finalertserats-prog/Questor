import { z } from 'zod';

// The one strength rule for every place a Questor account password is set.
//
// The floor was written out four times — /api/auth/register, both branches of
// /api/signup, and admin user creation — each as its own `z.string().min(12,
// ...)` with its own copy of the message. Four copies is four chances for the
// recovery path to end up weaker than the path it recovers, which would make
// "forgot password" the soft way into an account. They all call this now.
//
// Length over punctuation, deliberately: a 12-character floor with no
// composition rules is what NIST SP 800-63B recommends, and character-class
// rules mostly produce "Password1!".

export const PASSWORD_MIN_LENGTH = 12;

/** Shown wherever a password is rejected for being too short. */
export const PASSWORD_RULE_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;

/**
 * An upper bound, not a strength rule. bcrypt only reads the first 72 bytes, so
 * anything past that is silently ignored rather than making the password
 * stronger — and an unbounded field is a free way to make the server spend CPU
 * hashing a megabyte. Stated in characters because that is what a person types;
 * the byte check below is the one that matters to bcrypt.
 */
export const PASSWORD_MAX_LENGTH = 200;

/**
 * bcrypt truncates at 72 BYTES. A 72-character passphrase in Latin script fits;
 * the same length in Devanagari does not, and the tail would be quietly
 * discarded — two different passwords that both "work". Refuse instead of
 * truncating.
 */
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_TOO_LONG_MESSAGE = `Password must be at most ${PASSWORD_MAX_BYTES} bytes (roughly ${PASSWORD_MAX_BYTES} characters in English, fewer in other scripts)`;

/** The Zod shape every password field uses. Same rule, same wording, one place. */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_RULE_MESSAGE)
  .max(PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG_MESSAGE)
  .refine((pw) => Buffer.byteLength(pw, 'utf8') <= PASSWORD_MAX_BYTES, PASSWORD_TOO_LONG_MESSAGE);

/**
 * The same rule as a sentence, for callers that answer with their own shape
 * rather than letting a Zod error surface (the reset page, which must not vary
 * its wording in a way that says whether a link was real).
 */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return PASSWORD_RULE_MESSAGE;
  if (password.length > PASSWORD_MAX_LENGTH || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return PASSWORD_TOO_LONG_MESSAGE;
  return null;
}
