import { prisma } from '../db.js';
import { describeMissing, findMissingAwards, strikeMissingAwards } from './awardBackfill.js';

/**
 * Strikes the credentials the ladder owes candidates who were promoted while
 * the automatic moves were bypassing the award engine.
 *
 *   npm run awards:backfill -w server -- [--tenant <id>]           (reports only)
 *   npm run awards:backfill -w server -- --apply [--tenant <id>]   (writes)
 *   node dist/services/awardBackfillMain.js [--apply]              (production)
 *
 * A DRY RUN IS THE DEFAULT and `--apply` is the only way past it. This job
 * issues external artifacts: a credential is something a person may hand to
 * an employer, and a wrong one, a duplicate one or one with the wrong date is
 * not cleanly revocable. Read the whole report before deciding, and decide
 * per organisation if the list is long.
 *
 * Safe to run twice. The writer refuses a tier the candidate already holds,
 * and the unique (candidate, role, tier) key refuses it again underneath.
 *
 * What it never does: mint Bronze, which is the hiring team's reading and is
 * never issued to a candidate; mint a Diamond certificate, because Diamond
 * carries a badge and no printed document; or insert a row directly, so every
 * award it strikes carries real frozen evidence, a reference and a
 * verification token.
 *
 * Prints names, tiers and dates. No verification token is ever printed: it is
 * the key to a public page, and a terminal is not where it belongs.
 */

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function stringFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<number> {
  const apply = process.argv.includes('--apply');
  const tenantId = stringFlag('--tenant');

  const report = await findMissingAwards(tenantId ? { tenantId } : {});
  const strikeable = report.missing.filter((owed) => owed.credit !== null);
  const blocked = report.missing.filter((owed) => owed.credit === null);

  print(`Pipelines read: ${report.pipelinesRead} (${report.pipelinesWithoutTrail} with no recorded move)`);
  print(`Credentials owed: ${report.missing.length} — ${strikeable.length} strikeable, ${blocked.length} blocked`);
  print('');
  for (const owed of report.missing) print(`  ${describeMissing(owed)}`);
  if (report.missing.length === 0) print('  (none)');
  print('');

  if (!apply) {
    print('DRY RUN. Nothing was written. Re-run with --apply to strike the strikeable ones.');
    // The date above is the one the certificate will carry, and saying so
    // every time is the point: an operator reading this list has to be able
    // to check each date against the audit trail before a document goes out
    // under it.
    print('On --apply, each award is dated the move above, not the moment it is struck.');
    return 0;
  }

  const written = await strikeMissingAwards(report);
  print(`Struck ${written.struck.length} award(s):`);
  for (const award of written.struck) print(`  ${award.tier} ${award.reference} for candidate ${award.candidateId}`);
  if (blocked.length > 0) print(`${blocked.length} left alone; see the BLOCKED lines above.`);
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  print(`FAILED: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
process.exit(code);
