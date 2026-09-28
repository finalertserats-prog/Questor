import { prisma } from '../db.js';
import { releaseHeldLeases, runExclusive } from './jobs.js';
import { backfillArtifactEncryption } from './artifactBackfill.js';

/**
 * Seals the candidate content already in the database — CV text, transcripts
 * and reports — under ARTIFACT_ENCRYPTION_KEY.
 *
 *   npm run artifacts:encrypt -w server -- [--dry-run] [--batch 200] [--after <id>] [--max 5000]
 *   node dist/services/artifactBackfillMain.js [--dry-run] …            (production)
 *
 * Run it with the key set and ARTIFACT_ENCRYPTION_ENABLED still off — that is
 * the order in docs/RUNBOOK.md. The application reads sealed and clear rows
 * alike, so it keeps serving throughout and nothing has to be taken down.
 *
 * Safe to run twice: an already-sealed row is skipped. Interrupted, it is
 * resumed with `--after <lastId>` from the line it printed, or simply run
 * again from the start. Prints ids and counts only, never any part of a CV or
 * a transcript.
 */

/** Long enough for a large table in one hold; the sweep and the worker keep their own. */
const BACKFILL_LEASE = 'artifact-encryption-backfill';
const BACKFILL_LEASE_TTL_MS = 60 * 60_000;

function print(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function numberFlag(name: string): number | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number.`);
  return value;
}

function stringFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<number> {
  const options = {
    dryRun: process.argv.includes('--dry-run'),
    batchSize: numberFlag('--batch'),
    maxRows: numberFlag('--max'),
    after: stringFlag('--after') ?? null,
  };
  let progress: Awaited<ReturnType<typeof backfillArtifactEncryption>> | null = null;
  const outcome = await runExclusive(BACKFILL_LEASE, BACKFILL_LEASE_TTL_MS, async () => {
    progress = await backfillArtifactEncryption(options);
    return `artifact encryption backfill: ${progress.sealed} sealed, ${progress.rotated} rotated`;
  });
  if (outcome === 'skipped') {
    print({ ok: false, reason: 'another backfill is already running; wait for it to finish' });
    return 1;
  }
  const done = progress as Awaited<ReturnType<typeof backfillArtifactEncryption>> | null;
  if (outcome === 'failed' || !done) {
    print({ ok: false, reason: 'backfill failed; see the server log. Nothing already sealed is undone, and a re-run skips it.' });
    return 1;
  }
  print({ ok: true, dryRun: options.dryRun, ...done });
  // An unreadable row is not a crash, but it is not success either: the
  // operator has to find the key it names before the backfill is complete.
  return done.unreadable > 0 ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  print({ ok: false, reason: err instanceof Error ? err.message.slice(0, 300) : String(err) });
} finally {
  await releaseHeldLeases().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}
process.exit(code);
