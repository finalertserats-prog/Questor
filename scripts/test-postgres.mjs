#!/usr/bin/env node
// Run the server test suite against PostgreSQL.
//
//   TEST_DATABASE_URL=postgresql://user:pass@host:5432/db npm run test:pg -w server
//
// Generates the Postgres schema and Prisma client, runs the suite with one
// schema per test file (see server/tests/perFileDb.ts), and always restores the
// SQLite client afterwards so a normal `npm test` keeps working. The database
// named in TEST_DATABASE_URL has its test schemas reset: never point it at real data.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'server');

if (!(process.env.TEST_DATABASE_URL ?? '').startsWith('postgresql://')) {
  console.error('Set TEST_DATABASE_URL to a postgresql:// URL for a database whose test schemas may be reset.');
  process.exit(2);
}

const run = (command, args) =>
  spawnSync(command, args, { cwd: server, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;

let status = run('node', [join(root, 'scripts', 'generate-postgres-schema.mjs')]);
if (status === 0) status = run('npx', ['prisma', 'generate', '--schema', 'prisma/postgres/schema.prisma']);
if (status === 0) status = run('npx', ['vitest', 'run', ...process.argv.slice(2)]);

// Put the SQLite client back whatever happened above.
const restored = run('npx', ['prisma', 'generate']);
process.exit(status !== 0 ? status : restored);
