#!/usr/bin/env node
// Smoke-test committed Postgres migrations against a scratch database.
//
//   TEST_DATABASE_URL="postgresql://questor:questor@localhost:5432/questor?schema=public" npm run test:pg -w server
//
// The database/schema named by TEST_DATABASE_URL is reset. This project does
// not use Docker: use a local Postgres you already run (the release lane uses
// an embedded Postgres on port 54329) with a UTF8 database of its own —
// concurrent runs against one database reset each other's test_w* schemas:
//   TEST_DATABASE_URL="postgresql://questor:<password>@127.0.0.1:54329/questor_test_mine" node scripts/test-migrations.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unexpectedMigrationSql } from './migrationDiff.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = join(root, 'server', 'prisma', 'postgres', 'schema.prisma');
const migrations = join(root, 'server', 'prisma', 'postgres', 'migrations');
const testUrl = process.env.TEST_DATABASE_URL ?? '';

if (!testUrl.startsWith('postgresql://') && !testUrl.startsWith('postgres://')) {
  console.error('Set TEST_DATABASE_URL to a scratch postgresql:// URL. It will be reset.');
  process.exit(2);
}

function shadowUrlFrom(urlText) {
  const url = new URL(urlText);
  url.searchParams.set('schema', 'prisma_migration_shadow');
  return url.toString();
}

function commandLine(command, args) {
  return process.platform === 'win32' && command === 'npx'
    ? ['cmd.exe', ['/d', '/s', '/c', command, ...args]]
    : [command, args];
}

function run(command, args, options = {}) {
  const [exe, exeArgs] = commandLine(command, args);
  const result = spawnSync(exe, exeArgs, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: testUrl },
    ...options,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result;
}

run('node', [join(root, 'scripts', 'generate-postgres-schema.mjs')], { stdio: 'inherit' });
run('npx', ['prisma', 'migrate', 'reset', '--force', '--skip-seed', '--schema', schema], { stdio: 'inherit' });

const diff = run('npx', [
  'prisma', 'migrate', 'diff',
  '--from-migrations', migrations,
  '--to-schema-datamodel', schema,
  '--shadow-database-url', shadowUrlFrom(testUrl),
  '--script',
]);

// Hand-written partial indexes (scripts/migrationDiff.mjs) are expected to
// be missing from schema.prisma; any other difference fails the check.
const unexpected = unexpectedMigrationSql(diff.stdout);
if (unexpected) {
  console.error('Committed Postgres migrations do not match server/prisma/schema.prisma. Diff:');
  process.stderr.write(`${unexpected}\n`);
  process.exit(1);
}

console.log('Postgres migrations match the generated Prisma schema.');
