#!/usr/bin/env node
//
// Run the server's TypeScript projects, and when they fail, say whether the
// failure is a real type error or a stale Prisma client.
//
// This exists because the same failure was misdiagnosed four times in one
// session. The client Prisma generates lives in node_modules, which git does
// not track, so every worktree carries whatever client was generated last.
// The moment any lane changes the schema, every OTHER worktree's client is out
// of date — and with several lanes running at once, that is most of the time.
//
// The errors it produces look exactly like a broken rebase:
//
//   error TS2339: Property 'demoSpendDay' does not exist on type 'PrismaClient'
//   error TS2551: Property 'demoInterviewRun' does not exist on type
//                 'PrismaClient'. Did you mean 'interviewRound'?
//
// Each time, somebody read that as a lost migration or a bad merge and went
// looking through the history. The fix is one command, and it never varies.
//
// Production is not affected: scripts/deploy.sh regenerates the client on the
// VPS before it builds, so the box always compiles against the schema it is
// deploying. This is a local-development failure only.

import { spawnSync } from 'node:child_process';

const PROJECTS = [
  'tsconfig.json',
  'sim/tsconfig.json',
  'scripts/library-seed/tsconfig.json',
  'bench/tsconfig.json',
];

/** A type error that names PrismaClient is never a type error. */
const STALE_CLIENT = /does not exist on type '?PrismaClient/;

let failed = false;

for (const project of PROJECTS) {
  const args = project === 'tsconfig.json'
    ? ['tsc', '--noEmit', '-p', project]
    : ['tsc', '-p', project];
  const run = spawnSync('npx', args, { encoding: 'utf8', shell: true });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (output.trim()) process.stdout.write(output);
  if (run.status === 0) continue;

  failed = true;
  if (STALE_CLIENT.test(output)) {
    process.stdout.write(
      '\n'
      + '  The errors above name PrismaClient, which means the generated client\n'
      + '  is older than the schema — not that anything is wrong with the code.\n'
      + '  This is normal in a worktree after another lane changes the schema.\n'
      + '\n'
      + '  Fix it with:\n'
      + '    npx prisma generate --schema server/prisma/schema.prisma\n'
      + '\n'
      + '  then run this again. Production is unaffected: the deploy regenerates\n'
      + '  the client on the VPS before it builds.\n\n',
    );
  }
  break;
}

process.exit(failed ? 1 : 0);
