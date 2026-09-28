import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { runCatalogRefresh, startManualCatalogRefresh, _catalogRefreshSettled } from '../src/services/catalogRefresh.js';
import { CATALOG_REFRESH_LEASE } from '../src/services/catalogRefreshRun.js';
import { markDraining, _resetDraining } from '../src/services/drainState.js';
import { configureCatalogRefresh, proposalTitles, seedSmallCatalog, testDeps } from './catalogRefreshFixtures.js';

/**
 * One refresh run at a time, however long a chunk takes; a draining process
 * hands its run over instead of failing it; and the month's model spend is
 * bounded across runs, not per run.
 */

beforeEach(async () => {
  configureCatalogRefresh();
  await seedSmallCatalog();
});

afterEach(() => {
  _resetDraining();
});

async function latestRun() {
  return prisma.catalogRefreshRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
}

function gate() {
  let open: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { open = resolve; });
  return { closed, open };
}

describe('never two executors for one run', () => {
  it('refuses a second run in this process even after the first one\'s lease lapsed', async () => {
    const hold = gate();
    let chunks = 0;
    const first = runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { afterChunk: async () => { chunks += 1; if (chunks === 1) await hold.closed; } }).deps });
    while (chunks === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await prisma.jobLease.update({ where: { name: CATALOG_REFRESH_LEASE.name }, data: { expiresAt: new Date(Date.now() - 1) } });
    const second = await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    hold.open();
    await first;
    expect({ second: second.outcome, runs: await prisma.catalogRefreshRun.count() }).toEqual({ second: 'skipped', runs: 1 });
  });

  it('keeps the lease alive while a slow chunk runs', async () => {
    let expiresInMs = -1;
    const slowChunk = async () => {
      if (expiresInMs !== -1) return;
      await new Promise((resolve) => setTimeout(resolve, 700));
      const lease = await prisma.jobLease.findUniqueOrThrow({ where: { name: CATALOG_REFRESH_LEASE.name } });
      expiresInMs = lease.expiresAt.getTime() - Date.now();
    };
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { leaseTtlMs: 300, heartbeatMs: 50, afterChunk: slowChunk }).deps });
    expect(expiresInMs).toBeGreaterThan(0);
  });

  it('stops, leaving the run to be resumed, when another holder took the lease', async () => {
    let chunks = 0;
    const stealLease = async () => {
      chunks += 1;
      if (chunks === 1) await prisma.jobLease.update({ where: { name: CATALOG_REFRESH_LEASE.name }, data: { holder: 'other-host:1:abc#zz' } });
    };
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { onetChunkSize: 1, afterChunk: stealLease }).deps });
    const run = await latestRun();
    expect({ status: run.status, chunks }).toEqual({ status: 'running', chunks: 1 });
  });
});

describe('a draining process', () => {
  it('stops at the next checkpoint and leaves the run running for the next instance', async () => {
    let chunks = 0;
    const drainAfterFirst = async () => { chunks += 1; if (chunks === 1) markDraining(); };
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { onetChunkSize: 1, afterChunk: drainAfterFirst }).deps });
    const run = await latestRun();
    expect({ status: run.status, error: run.error, chunks }).toEqual({ status: 'running', error: '', chunks: 1 });
  });
});

describe('the pending-proposal backstop', () => {
  it('skips a title another writer queued meanwhile instead of failing the run', async () => {
    // The Postgres migration adds this unique index; SQLite gets it here.
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "CatalogProposal_pending_key" ON "CatalogProposal" ("normalizedTitle", "kind", COALESCE("targetRoleId", ''), COALESCE("domainId", '')) WHERE "status" = 'pending'`);
    const run = await prisma.catalogRefreshRun.create({ data: { trigger: 'manual', status: 'completed', finishedAt: new Date() } });
    const catalog = await prisma.catalogRole.findFirstOrThrow({ where: { title: 'Software Engineer' } });
    let chunks = 0;
    // After the run has loaded what is pending, another writer queues one of its titles.
    const sneakIn = async () => {
      chunks += 1;
      if (chunks !== 1) return;
      await prisma.catalogProposal.create({ data: { runId: run.id, kind: 'new_role', title: 'Software Quality Engineer', normalizedTitle: 'software quality engineer', domainId: catalog.domainId, sourcesJson: '[]', confidence: 0.5 } });
    };
    const result = await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { onetChunkSize: 1, afterChunk: sneakIn }).deps });
    const titles = await proposalTitles();
    expect({ outcome: result.outcome, status: (await latestRun()).status, sqe: titles.filter((t) => t === 'Software Quality Engineer').length }).toEqual({ outcome: 'ran', status: 'completed', sqe: 1 });
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "CatalogProposal_pending_key"');
  });
});

describe('spend across runs', () => {
  it('limits model calls over 30 days, not per run', async () => {
    configureCatalogRefresh({ maxLlmCalls: 10, llmCallsPer30Days: 3 });
    await prisma.catalogRefreshRun.create({ data: { trigger: 'manual', status: 'completed', startedAt: new Date(Date.now() - 86_400_000), finishedAt: new Date(), llmCalls: 3 } });
    let calls = 0;
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { model: async () => { calls += 1; return []; }, modelAvailable: true }).deps });
    expect(calls).toBe(0);
  });

  it('counts calls from runs older than 30 days as spent no longer', async () => {
    configureCatalogRefresh({ maxLlmCalls: 10, llmCallsPer30Days: 3 });
    await prisma.catalogRefreshRun.create({ data: { trigger: 'manual', status: 'completed', startedAt: new Date(Date.now() - 31 * 86_400_000), finishedAt: new Date(Date.now() - 31 * 86_400_000), llmCalls: 3 } });
    let calls = 0;
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { model: async () => { calls += 1; return []; }, modelAvailable: true }).deps });
    expect(calls).toBe(1);
  });

  it('limits research calls over 30 days', async () => {
    configureCatalogRefresh({ researchMaxCalls: 5, researchCallsPer30Days: 1 });
    const reply = JSON.stringify([]);
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({ research: reply }, { researchKey: 'sk-test' }).deps });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({ research: reply }, { researchKey: 'sk-test' }).deps });
    const runs = await prisma.catalogRefreshRun.findMany({ select: { researchCalls: true } });
    expect(runs.reduce((sum, r) => sum + r.researchCalls, 0)).toBe(1);
  });

  it('refuses a second manual run within the hour, saying when it may run', async () => {
    configureCatalogRefresh({ manualRunGapMs: 60 * 60_000 });
    const owner = await prisma.tenant.create({ data: { name: 'Gap org', users: { create: { email: `gap-${Date.now()}@x.test`, name: 'Owner', passwordHash: 'x', role: 'admin' } } }, include: { users: true } });
    await startManualCatalogRefresh(owner.users[0].id, testDeps({}).deps);
    await _catalogRefreshSettled();
    const second = await startManualCatalogRefresh(owner.users[0].id, testDeps({}).deps);
    expect(second.kind === 'too_soon' && second.retryAt instanceof Date).toBe(true);
  });
});
