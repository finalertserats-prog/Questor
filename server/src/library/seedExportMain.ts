import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../db.js';
import { exportSeedPools } from './seedExport.js';

/**
 * Writes the pools an offline seed run should fill:
 *
 *   npm run library:seed-export -- --out pools.json [--roles a,b] [--bands developing,senior] [--limit 40]
 *   node dist/library/seedExportMain.js --out pools.json ...        (production)
 *
 * Read-only. Prints counts only. The file holds global-catalog text only:
 * catalog roles, platform competencies in the platform's wording, family
 * standards and global library questions. No organisation's scorecard or
 * competency wording is written (seedExport.ts).
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function list(name: string): string[] | undefined {
  const value = arg(name);
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

async function main(): Promise<number> {
  const out = arg('out');
  if (!out) {
    process.stderr.write('Usage: seedExportMain --out pools.json [--roles slug,slug] [--bands band,band] [--limit n]\n');
    return 2;
  }
  const limitText = arg('limit');
  const file = await exportSeedPools({ roles: list('roles'), bands: list('bands'), limit: limitText ? Number.parseInt(limitText, 10) : undefined });
  writeFileSync(resolve(out), `${JSON.stringify(file, null, 1)}\n`, 'utf8');
  const roles = new Set(file.pools.map((p) => p.roleSlug)).size;
  process.stdout.write(`${JSON.stringify({ ok: true, pools: file.pools.length, roles, withStandard: file.pools.filter((p) => p.standard).length, skippedOrgCompetencyPools: file.skippedOrgCompetencyPools, out: resolve(out) })}\n`);
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) })}\n`);
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
process.exit(code);
