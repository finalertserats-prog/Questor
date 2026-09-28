import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { artifactKeyring } from './artifactContent.js';
import { artifactKeyId, isSealedArtifact, openArtifact, sealArtifact } from './artifactSeal.js';

/**
 * Sealing the candidate content already in the database.
 *
 * Rows written before encryption was switched on hold CV text, transcripts and
 * reports in clear (services/artifactSeal.ts explains why the column is named
 * storageKey and holds content). Reading is transparent, so the application
 * works either way; this is what makes the backups stop being readable.
 *
 * Three properties the operator depends on:
 *
 *   RESUMABLE. Rows are taken in id order and the last id handled is returned,
 *   so a run interrupted after an hour is continued with `--after <id>` rather
 *   than begun again. It is equally correct to just re-run from the start.
 *
 *   IDEMPOTENT. An already-sealed row is counted and skipped. Running this
 *   twice seals nothing twice, and a row sealed under the key being retired is
 *   re-sealed under the active one, which is what makes this a rotation tool
 *   as well.
 *
 *   SILENT ABOUT CONTENT. Nothing it prints or logs contains any part of a CV
 *   or a transcript — only ids, counts and reasons.
 */

export interface ArtifactBackfillProgress {
  /** Rows looked at. */
  readonly scanned: number;
  /** Rows sealed by this run. */
  readonly sealed: number;
  /** Rows already sealed under the active key. */
  readonly alreadySealed: number;
  /** Rows re-sealed from a retired key onto the active one. */
  readonly rotated: number;
  /** Rows no key we hold can open. Left exactly as they are. */
  readonly unreadable: number;
  /** The last id handled, for `--after` on the next run. */
  readonly lastId: string | null;
  /** False when the batch limit stopped the run before the end of the table. */
  readonly done: boolean;
}

export interface ArtifactBackfillOptions {
  /** Rows per database page. */
  readonly batchSize?: number;
  /** Resume point: only rows with a greater id are considered. */
  readonly after?: string | null;
  /** Stop after this many rows have been looked at. Unlimited by default. */
  readonly maxRows?: number;
  /** Report what would change without writing anything. */
  readonly dryRun?: boolean;
}

const DEFAULT_BATCH = 200;

/**
 * Seal every unsealed artifact, in batches.
 *
 * Runs whatever the ARTIFACT_ENCRYPTION_ENABLED switch says: the owner's order
 * is key, then backfill, then the switch, so this has to work while the switch
 * is still off. It refuses only when there is no key to seal under.
 */
export async function backfillArtifactEncryption(opts: ArtifactBackfillOptions = {}): Promise<ArtifactBackfillProgress> {
  const keyring = artifactKeyring();
  if (!keyring.active) {
    throw new Error('ARTIFACT_ENCRYPTION_KEY is not set, so there is no key to seal candidate content under.');
  }
  const active = keyring.active;
  const activeKeyId = artifactKeyId(active);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;

  let cursor = opts.after ?? null;
  let scanned = 0;
  let sealed = 0;
  let alreadySealed = 0;
  let rotated = 0;
  let unreadable = 0;
  let lastId: string | null = null;

  for (;;) {
    if (scanned >= maxRows) return { scanned, sealed, alreadySealed, rotated, unreadable, lastId, done: false };
    const take = Math.min(batchSize, maxRows - scanned);
    const rows = await prisma.artifact.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: 'asc' },
      take,
      select: { id: true, storageKey: true },
    });
    if (rows.length === 0) return { scanned, sealed, alreadySealed, rotated, unreadable, lastId, done: true };

    for (const row of rows) {
      scanned += 1;
      lastId = row.id;
      cursor = row.id;
      const wasSealed = isSealedArtifact(row.storageKey);
      let content: string;
      try {
        content = openArtifact(row.storageKey, keyring);
      } catch {
        // A row under a key this deployment does not hold. Left untouched:
        // overwriting it would destroy the only copy. The id is enough for an
        // operator to find it; the reason is already in the logs from the read.
        unreadable += 1;
        logger.warn({ artifactId: row.id }, 'Artifact could not be opened with any key held; left as it is');
        continue;
      }
      // Sealed, and under the key we would seal it with now: nothing to do.
      if (wasSealed && row.storageKey.split('.')[2] === activeKeyId) {
        alreadySealed += 1;
        continue;
      }
      if (opts.dryRun) {
        if (wasSealed) rotated += 1; else sealed += 1;
        continue;
      }
      // Conditional on the value we read, so a row rewritten in between — a
      // second backfill, a rotation — is left to whoever wrote it rather than
      // being sealed twice or stamped back to an older key.
      const { count } = await prisma.artifact.updateMany({
        where: { id: row.id, storageKey: row.storageKey },
        data: { storageKey: sealArtifact(content, active) },
      });
      if (count === 1) {
        if (wasSealed) rotated += 1; else sealed += 1;
      } else {
        alreadySealed += 1;
      }
    }
  }
}
