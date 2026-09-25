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
  // Postgres runs (npm run test:pg) isolate each test file in its own schema
  // instead; see perFileDb.ts. The SQLite template is not needed.
  if (process.env.TEST_DATABASE_URL?.startsWith('postgresql://')) return;

  mkdirSync(DATA_DIR, { recursive: true });

  // Leftovers from a killed run would otherwise accumulate and, worse, a stale
  // per-worker file could be reused with an out-of-date schema.
  //
  // A file another vitest process still holds open cannot be unlinked, and on
  // Windows that throws EBUSY. Saying so beats dying here: the leftover is a
  // symptom of a second run, and the second run is the thing to fix.
  for (const f of readdirSync(DATA_DIR)) {
    if (!/^test-w\d+\.db($|-)/.test(f)) continue;
    try {
      unlinkSync(join(DATA_DIR, f));
    } catch (err) {
      throw new Error(
        `Could not remove the leftover test database ${f}: ${(err as Error).message}\n`
        + 'Another vitest run is almost certainly still going in this worktree. '
        + 'Wait for it to finish, then retry. The test databases are shared per '
        + 'worktree, so two suites cannot run at once.',
      );
    }
  }
  rmSync(TEMPLATE_DB, { force: true });

  // NOT stdio: 'ignore'. When this push failed silently — a stale client, a
  // locked engine binary, a concurrent run deleting the file underneath it —
  // the template was left missing or half-built, and every DB-touching suite
  // afterwards failed on a missing table. That presented as hundreds of
  // unrelated assertion failures across dozens of files, and it was
  // misdiagnosed three separate times in one session before anyone thought to
  // run this command by hand. The output costs nothing; the silence cost hours.
  try {
    execSync('npx prisma db push --skip-generate --accept-data-loss', {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: 'file:./data/template.db' },
    });
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
    throw new Error(
      'Could not build the test database template, so no suite can run.\n'
      + `${e.stderr?.toString() || e.stdout?.toString() || e.message || 'no output'}\n`
      + 'Try: npx prisma generate --schema server/prisma/schema.prisma',
    );
  }
}
