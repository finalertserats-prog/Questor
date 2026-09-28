#!/usr/bin/env node
// One library batch end to end against the configured providers, after a
// deploy. Prints counts only (never prompts, keys or question text); exits
// non-zero on failure. Runs the built worker when dist/ exists (production),
// otherwise the TypeScript source through tsx (development).
//
//   node scripts/library-smoke.mjs
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(server, 'dist', 'library', 'smoke.js');

const [command, args] = existsSync(built)
  ? [process.execPath, [built]]
  : [process.execPath, ['--import', 'tsx', join(server, 'src', 'library', 'smoke.ts')]];

const result = spawnSync(command, args, { cwd: server, stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
