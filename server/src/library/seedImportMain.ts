import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../db.js';
import { releaseHeldLeases, runExclusive } from '../services/jobs.js';
import { importSeedLines, type SeedImportReport } from './seedImport.js';
import { LIBRARY_WORKER_LEASE } from './worker.js';

/**
 * Imports a seed file written offline by scripts/library-seed:
 *
 *   npm run library:seed-import -- seed.jsonl [--report report.json]
 *   node dist/library/seedImportMain.js seed.jsonl [--report report.json]   (production)
 *
 * Every question goes through the worker's gates (seedImport.ts). It runs
 * under the library worker's own lease, so it never gates the same pools as a
 * running worker: stop the worker first (`pm2 stop questor-library`) if it is
 * on. Safe to run twice: a question already imported is skipped. Prints
 * counts only, never question text; the optional report lists line numbers
 * and reasons.
 */

/** Longer than the worker's lease: a large file is imported in one hold. */
const IMPORT_LEASE_TTL_MS = 60 * 60_000;

function print(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    process.stderr.write('Usage: seedImportMain <seed.jsonl> [--report report.json]\n');
    return 2;
  }
  const lines = readFileSync(resolve(file), 'utf8').split(/\r?\n/);
  let report: SeedImportReport | null = null;
  const outcome = await runExclusive(LIBRARY_WORKER_LEASE.name, IMPORT_LEASE_TTL_MS, async () => {
    report = await importSeedLines(lines);
    return `seed import: ${report.questions.probational + report.questions.queued + report.questions.rejected} written`;
  });
  if (outcome === 'skipped') {
    print({ ok: false, reason: 'the library worker holds its lease; stop it (pm2 stop questor-library) and import again' });
    return 1;
  }
  const done = report as SeedImportReport | null;
  if (outcome === 'failed' || !done) {
    print({ ok: false, reason: 'import failed; see the server log (nothing already written is undone, and a re-run skips it)' });
    return 1;
  }
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex > 0 && process.argv[reportIndex + 1]) writeFileSync(resolve(process.argv[reportIndex + 1]), `${JSON.stringify(done, null, 1)}\n`, 'utf8');
  print({
    ok: true, lines: done.lines, invalid: done.invalid.length, refused: done.refused.length,
    standards: { created: done.standards.created, existing: done.standards.existing, rejected: done.standards.rejected.length },
    questions: done.questions, reasons: done.reasons,
  });
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  print({ ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) });
} finally {
  await releaseHeldLeases().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}
process.exit(code);
