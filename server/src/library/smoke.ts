import { config } from '../config.js';
import { prisma } from '../db.js';
import { loadDemandQueue } from './demand.js';
import { loadPolicy } from './policy.js';
import { currentBudget, defaultWorkerDeps, runBatch } from './worker.js';

/**
 * One batch end to end against the configured providers, for the thinnest
 * pool in the queue. Prints counts only: never a prompt, a key or question
 * text. Exit 1 on any failure. Run after a deploy (scripts/library-smoke.mjs).
 *
 * It spends real calls, so it needs the worker switch on; a dark deployment
 * reports that and exits 0 without spending anything.
 */

function print(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<number> {
  if (!config.library.workerEnabled) {
    print({ ok: true, ran: false, reason: 'LIBRARY_WORKER_ENABLED is not true' });
    return 0;
  }
  const deps = defaultWorkerDeps();
  if (!deps.generatorEnabled) {
    print({ ok: false, ran: false, reason: 'generator provider has no key' });
    return 1;
  }
  try {
    deps.critic();
  } catch (err) {
    print({ ok: false, ran: false, reason: err instanceof Error ? err.message : 'critic unavailable' });
    return 1;
  }
  const queue = await loadDemandQueue(new Date());
  if (queue.length === 0) {
    print({ ok: true, ran: false, reason: 'no pool below target' });
    return 0;
  }
  const pool = queue[0];
  const policy = await loadPolicy();
  const result = await runBatch(pool, deps, policy);
  const budget = await currentBudget();
  print({
    ok: true, ran: true, priority: pool.priority, generated: result.generated, probational: result.probational, queued: result.queued,
    rejected: result.rejected, standardCreated: result.standardCreated, tokens: result.tokens.input + result.tokens.output,
    callsUsedToday: budget.callsUsedToday, dailyCap: budget.dailyCap,
  });
  return result.generated > 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  print({ ok: false, ran: true, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) });
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
process.exit(code);
