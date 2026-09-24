import { config } from '../config.js';
import {
  openArtifact, parseArtifactKey, parseArtifactKeys, sealArtifact, type ArtifactKeyring,
} from './artifactSeal.js';

/**
 * The deployment's view of artifact encryption: the keyring from the
 * environment, and the two calls every write and read goes through.
 *
 * Kept apart from artifactSeal.ts so the cipher stays a pure function with its
 * own tests, and this file holds the one thing that is not pure — reading
 * config, once, and caching it.
 */

let cached: ArtifactKeyring | null = null;

/** Forget the cached keyring. Tests change the environment between cases. */
export function _resetArtifactKeyring(): void {
  cached = null;
}

/**
 * The keys this deployment holds. Throws ArtifactKeyError on a malformed key,
 * which at boot is what preflight reports and at runtime is what stops a write
 * going out unsealed while the operator believes it is sealed.
 */
export function artifactKeyring(): ArtifactKeyring {
  if (cached) return cached;
  const { key, previousKeys } = config.artifactEncryption;
  cached = {
    active: key.trim() ? parseArtifactKey('ARTIFACT_ENCRYPTION_KEY', key) : null,
    previous: parseArtifactKeys('ARTIFACT_ENCRYPTION_KEYS_PREVIOUS', previousKeys),
  };
  return cached;
}

/**
 * Whether new writes are sealed. Both the switch and a key are needed.
 *
 * The switch on with no key is a misconfiguration. Production refuses to boot
 * on it. Development does write clear text, deliberately — a developer with no
 * key still needs the app to run — and the boot warning is the only thing
 * standing between that and an operator who believes their rows are sealed, so
 * the warning is not optional and must never be softened to a debug line.
 */
export function artifactEncryptionOn(): boolean {
  return config.artifactEncryption.enabled && artifactKeyring().active !== null;
}

/**
 * What to store in `Artifact.storageKey` for this content. Clear text while
 * encryption is off, which is exactly what a row written before the switch
 * looks like — so the two are indistinguishable to every reader.
 */
export function storedArtifactContent(content: string): string {
  const { active } = artifactKeyring();
  return artifactEncryptionOn() && active ? sealArtifact(content, active) : content;
}

/**
 * The content back. Clear text passes through untouched, so rows written
 * before the backfill keep working; an envelope is opened, and one we hold no
 * key for throws UnreadableArtifactError rather than returning its ciphertext.
 */
export function readArtifactContent(stored: string): string {
  return openArtifact(stored, artifactKeyring());
}
