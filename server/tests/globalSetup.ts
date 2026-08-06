import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'prisma', 'data');
export const TEMPLATE_DB = join(DATA_DIR, 'template.db');

/**
 * Build ONE schema'd database that every test file copies.
 *
 * Files used to share a single test.db. Each one calls `wipe()` in `beforeAll`,
 * so whichever file ran second deleted the first's fixtures — producing a suite
 * that failed with a different set of 404s and 500s on every run while each
 * file passed alone. Sequencing the files was not enough, because the shared
 * resource is the FILE, not the schedule.
 *
 * Copying a prepared template is far cheaper than running `prisma db push` per
 * worker, and gives each file a database nothing else can touch.
 */
export default function setup() {
  mkdirSync(DATA_DIR, { recursive: true });

  // Leftovers from a killed run would otherwise accumulate and, worse, a stale
  // per-worker file could be reused with an out-of-date schema.
  for (const f of readdirSync(DATA_DIR)) {
    if (/^test-w\d+\.db($|-)/.test(f)) unlinkSync(join(DATA_DIR, f));
  }
  rmSync(TEMPLATE_DB, { force: true });

  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: `file:./data/${'template.db'}` },
  });
}
