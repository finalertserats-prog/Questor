import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Field-level encryption for the candidate content stored in
 * `Artifact.storageKey`.
 *
 * Despite the column's name there is no object store behind it: the CV's
 * extracted text (services/resumeProfile.ts), the interview transcript and the
 * report (realtime/interviewEngine.ts, services/incompleteInterviews.ts) are
 * written into it inline. Every database backup therefore held the whole of a
 * candidate's interview in clear text. This module seals it under AES-256-GCM,
 * the same cipher that already protects invitation links and connector
 * credentials (services/secretSeal.ts), with three differences that this data
 * needs and a credential does not:
 *
 *   ITS OWN KEY. `ARTIFACT_ENCRYPTION_KEY`, not AUTH_SECRET. Rotating
 *   AUTH_SECRET is a routine act that costs an admin a re-entered API key;
 *   doing it to a transcript would destroy evidence we are obliged to be able
 *   to produce. The two must not share a fate.
 *
 *   A KEY ID IN THE ENVELOPE. Every sealed value names the key that sealed it,
 *   so a row written under a retired key can still be opened while it is being
 *   re-sealed, and a row we cannot open says which key it wants instead of
 *   failing namelessly.
 *
 *   FAILURE IS LOUD. secretSeal returns null for a value it cannot open, which
 *   for an API key means "ask the admin again". A transcript that cannot be
 *   opened must never be silently read as empty, so this throws.
 *
 * Reading is transparent: content stored before encryption was switched on is
 * not sealed, is not shaped like an envelope, and comes back exactly as it is.
 * That is what lets the flag be turned on without a migration first.
 */

/** Marks a sealed value. Chosen so no CV, transcript or report begins with it. */
export const ARTIFACT_SEAL_PREFIX = 'qenc.v1.';

const ENVELOPE_VERSION = 'v1';
const ENVELOPE_PARTS = 6;
const IV_BYTES = 12;
/** AES-GCM's authentication tag, at the default length. */
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Enough that two keys in use at once never collide; short enough to read in a log. */
const KEY_ID_CHARS = 12;

/** A configured key is bad: the deployment is misconfigured, not the data. */
export class ArtifactKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactKeyError';
  }
}

/** A stored value cannot be opened with any key we hold. */
export class UnreadableArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableArtifactError';
  }
}

/** The active key new writes are sealed under, and every key still able to read. */
export interface ArtifactKeyring {
  /** Null where encryption is switched off, or no key is configured. */
  readonly active: Buffer | null;
  /** Keys being retired: they open old rows but seal nothing. */
  readonly previous: readonly Buffer[];
}

/**
 * A short, stable name for a key, derived so that holding the id tells you
 * nothing about the key. It goes in the envelope and in operator messages.
 */
export function artifactKeyId(key: Buffer): string {
  return createHash('sha256').update('questor-artifact-key-id:').update(key).digest('hex').slice(0, KEY_ID_CHARS);
}

/**
 * A 32-byte key from a base64 or hex string. Hex is accepted because
 * `openssl rand -hex 32` is what an operator reaches for first, and a key
 * pasted in the wrong encoding should work rather than silently become the
 * wrong key.
 */
export function parseArtifactKey(variable: string, raw: string): Buffer {
  const value = raw.trim();
  if (!value) throw new ArtifactKeyError(`${variable} is empty.`);
  const decoded = /^[0-9a-fA-F]+$/.test(value) && value.length === KEY_BYTES * 2
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  // Never the value itself: this runs at boot and the message reaches a log.
  if (decoded.length !== KEY_BYTES) {
    throw new ArtifactKeyError(
      `${variable} must be a ${KEY_BYTES}-byte key in base64 or hex (got ${decoded.length} bytes). `
      + `Generate one with: openssl rand -base64 ${KEY_BYTES}`,
    );
  }
  return decoded;
}

/** A comma-separated list of keys; an unset or blank value is no keys. */
export function parseArtifactKeys(variable: string, raw: string): Buffer[] {
  return raw.split(',').map((part) => part.trim()).filter(Boolean)
    .map((part, i) => parseArtifactKey(`${variable}[${i}]`, part));
}

/**
 * Recognises an envelope of ANY version, not only the one we write. A row
 * sealed by a later version of Questor must be refused, not handed back as if
 * the ciphertext were the candidate's words.
 *
 * The shape is matched, not just the prefix. Artifact content is a candidate's
 * CV or their own words, so a candidate can choose to write "qenc.v1.a.b.c.d"
 * into a CV; against a prefix test alone that turns their clear-text row into
 * one that refuses to open. Every field here is fixed-width or a base64url
 * alphabet: a 12-character hex key id, a 12-byte iv and a 16-byte tag (16 and
 * 22 unpadded base64url characters), then ciphertext. Prose does not reach
 * this by accident, and a candidate who reproduces it exactly has written a
 * value that only fails to decrypt — it cannot read anyone else's row.
 */
const ENVELOPE = new RegExp(
  `^qenc\\.v\\d+\\.[0-9a-f]{${KEY_ID_CHARS}}`
  + `\\.[A-Za-z0-9_-]{${Math.ceil((IV_BYTES * 4) / 3)}}`
  + `\\.[A-Za-z0-9_-]{${Math.ceil((TAG_BYTES * 4) / 3)}}`
  + '\\.[A-Za-z0-9_-]*$',
);

export function isSealedArtifact(stored: string): boolean {
  return ENVELOPE.test(stored) && stored.split('.').length === ENVELOPE_PARTS;
}

/**
 * Seal content for storage. The envelope is
 * `qenc.v1.<keyId>.<iv>.<tag>.<ciphertext>`, the last three base64url.
 */
export function sealArtifact(content: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
  return [
    'qenc', ENVELOPE_VERSION, artifactKeyId(key),
    iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url'),
  ].join('.');
}

function keysFor(keyId: string, keyring: ArtifactKeyring): Buffer[] {
  const held = [keyring.active, ...keyring.previous].filter((k): k is Buffer => k !== null);
  const matching = held.filter((k) => artifactKeyId(k) === keyId);
  // A key id collision is not worth guarding against, but trying every held key
  // when none announces itself costs nothing and covers an id scheme change.
  return matching.length > 0 ? matching : held;
}

/**
 * Content back from storage.
 *
 * A value that is not an envelope is clear text written before encryption was
 * switched on, and is returned as it is — that transparency is what lets the
 * flag be turned on ahead of the backfill. A value that is an envelope and
 * cannot be opened throws: reading a transcript as empty, or as its own
 * ciphertext, would be worse than failing.
 */
export function openArtifact(stored: string, keyring: ArtifactKeyring): string {
  if (!isSealedArtifact(stored)) return stored;
  const [, version, keyId, iv, tag, ciphertext] = stored.split('.');
  if (version !== ENVELOPE_VERSION) {
    throw new UnreadableArtifactError(
      `This candidate content was sealed in format "${version}", which this version of Questor cannot read.`,
    );
  }
  for (const key of keysFor(keyId, keyring)) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, or a tampered envelope. Try the next; report below.
    }
  }
  // The key id, never the content: this message reaches logs and API responses.
  throw new UnreadableArtifactError(
    `This candidate content was sealed under artifact encryption key "${keyId}", which this deployment does not hold. `
    + 'Restore that key in ARTIFACT_ENCRYPTION_KEY or ARTIFACT_ENCRYPTION_KEYS_PREVIOUS.',
  );
}

/** Whether two keys are the same, without leaking how nearly they matched. */
export function sameArtifactKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
