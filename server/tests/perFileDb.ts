import { copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// Give this test file its own database, before anything imports Prisma.
//
// `setupFiles` runs inside the worker ahead of the test module, and
// `src/db.ts` constructs its PrismaClient at import time — so this is the last
// moment DATABASE_URL can still be changed and be respected.
//
// VITEST_POOL_ID is unique per worker, and with `isolate: true` each file gets
// a fresh worker, so no two files can land on the same database. That is what
// finally removed the cross-file 404s: the previous shared test.db meant every
// file's `wipe()` in beforeAll deleted whatever the last file was still relying
// on.
const workerId = process.env.VITEST_POOL_ID ?? '0';
const postgresUrl = process.env.TEST_DATABASE_URL;

if (postgresUrl?.startsWith('postgresql://')) {
  // Postgres run (npm run test:pg): the same isolation, as a schema per worker
  // in the test database, reset and pushed fresh for every file.
  const url = new URL(postgresUrl);
  url.searchParams.set('schema', `test_w${workerId}`);
  execSync('npx prisma db push --skip-generate --force-reset --schema prisma/postgres/schema.prisma', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: url.toString() },
  });
  process.env.DATABASE_URL = url.toString();
} else {
  const dbFile = `test-w${workerId}.db`;
  const dataDir = join(process.cwd(), 'prisma', 'data');

  // Copy the schema'd template rather than running a migration per worker —
  // same result, a fraction of the time.
  copyFileSync(join(dataDir, 'template.db'), join(dataDir, dbFile));

  process.env.DATABASE_URL = `file:./data/${dbFile}`;
}
