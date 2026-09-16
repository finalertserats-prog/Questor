#!/usr/bin/env node
// Manage committed Prisma migrations for the generated Postgres schema.
//
// Usage:
//   node scripts/migrations.mjs baseline
//   SHADOW_DATABASE_URL="postgresql://questor:questor@localhost:5432/questor_shadow?schema=public" \
//     node scripts/migrations.mjs new add_candidate_flags
//
// `new` needs a scratch Postgres database for Prisma's shadow database. With
// the local compose service, one simple setup is:
//   docker compose up -d db
//   docker compose exec db createdb -U questor questor_shadow
//   export SHADOW_DATABASE_URL="postgresql://questor:questor@localhost:5432/questor_shadow?schema=public"
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = join(root, 'server', 'prisma', 'postgres', 'schema.prisma');
const migrations = join(root, 'server', 'prisma', 'postgres', 'migrations');

function run(command, args, options = {}) {
  const commandLine = process.platform === 'win32' && command === 'npx'
    ? ['cmd.exe', ['/d', '/s', '/c', command, ...args]]
    : [command, args];
  const result = spawnSync(commandLine[0], commandLine[1], {
    cwd: root,
    encoding: 'utf8',
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

function regenerate() {
  const result = run('node', [join(root, 'scripts', 'generate-postgres-schema.mjs')], { stdio: 'inherit' });
  return result;
}

function prisma(args) {
  return run('npx', ['prisma', ...args]);
}

function assertNonEmptyMigration(sql) {
  const meaningful = sql
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .join('\n')
    .trim();
  return meaningful.length > 0;
}

function sanitizeName(raw) {
  const name = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) {
    console.error('Usage: node scripts/migrations.mjs new <name>');
    process.exit(2);
  }
  return name;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function baseline() {
  regenerate();
  const dir = join(migrations, '0001_baseline');
  const file = join(dir, 'migration.sql');
  if (existsSync(file) || existsSync(dir)) {
    console.error(`Refusing to overwrite existing baseline at ${dir}`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  const result = prisma([
    'migrate', 'diff',
    '--from-empty',
    '--to-schema-datamodel', schema,
    '--script',
  ]);
  writeFileSync(file, result.stdout);
  console.log(`Wrote ${file}`);
}

function newMigration(rawName) {
  if (!process.env.SHADOW_DATABASE_URL?.startsWith('postgresql://') && !process.env.SHADOW_DATABASE_URL?.startsWith('postgres://')) {
    console.error('Set SHADOW_DATABASE_URL to a scratch Postgres database URL.');
    console.error('Local example: docker compose up -d db && docker compose exec db createdb -U questor questor_shadow');
    process.exit(2);
  }
  const name = sanitizeName(rawName);
  regenerate();
  const result = prisma([
    'migrate', 'diff',
    '--from-migrations', migrations,
    '--to-schema-datamodel', schema,
    '--shadow-database-url', process.env.SHADOW_DATABASE_URL,
    '--script',
  ]);
  if (!assertNonEmptyMigration(result.stdout)) {
    console.error('No schema diff; refusing to create an empty migration.');
    process.exit(1);
  }
  const dir = join(migrations, `${timestamp()}_${name}`);
  const file = join(dir, 'migration.sql');
  if (existsSync(dir)) {
    console.error(`Refusing to overwrite existing migration at ${dir}`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, result.stdout);
  console.log(`Wrote ${file}`);
}

const [command, name] = process.argv.slice(2);
switch (command) {
  case 'baseline':
    baseline();
    break;
  case 'new':
    newMigration(name);
    break;
  default:
    console.error('Usage: node scripts/migrations.mjs baseline | new <name>');
    process.exit(2);
}
