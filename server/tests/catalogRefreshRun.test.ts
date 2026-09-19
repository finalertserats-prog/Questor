import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { normalizeTitle } from '../src/domain/catalogText.js';
import { runCatalogRefresh } from '../src/services/catalogRefresh.js';
import { configureCatalogRefresh, proposalTitles, seedSmallCatalog, testDeps, type SeededCatalog } from './catalogRefreshFixtures.js';

/**
 * The refresh engine against a small catalog and scripted sources: what it
 * proposes, what it refuses to propose, and how it survives failures.
 */

let catalog: SeededCatalog;

beforeEach(async () => {
  configureCatalogRefresh();
  catalog = await seedSmallCatalog();
});

async function latestRun() {
  return prisma.catalogRefreshRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
}

async function pendingProposal(runId: string, title: string, kind: 'new_role' | 'new_alias') {
  return prisma.catalogProposal.create({
    data: { runId, kind, status: 'pending', title, normalizedTitle: normalizeTitle(title), sourcesJson: '[{"source":"onet","ref":"x"}]', confidence: 0.7, domainId: catalog.techId, targetRoleId: kind === 'new_alias' ? catalog.sweId : null },
  });
}

async function priorRun() {
  return prisma.catalogRefreshRun.create({ data: { trigger: 'schedule', status: 'completed', finishedAt: new Date() } });
}

describe('a refresh run over O*NET', () => {
  it('completes and records the run', async () => {
    const { deps } = testDeps({});
    const result = await runCatalogRefresh({ trigger: 'manual', deps });
    const run = await latestRun();
    expect({ outcome: result.outcome, status: run.status, id: result.runId, finished: run.finishedAt !== null }).toEqual({ outcome: 'ran', status: 'completed', id: run.id, finished: true });
  });

  it('proposes the unknown titles of a matched occupation as aliases of its role', async () => {
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    const aliases = await prisma.catalogProposal.findMany({ where: { kind: 'new_alias' }, orderBy: { title: 'asc' } });
    expect(aliases.map((a) => [a.title, a.targetRoleId])).toEqual([
      ['Application Developer', catalog.sweId],
      ['Code Writer', catalog.sweId],
      ['Software Developers', catalog.sweId],
    ]);
  });

  it('proposes an unmatched occupation as a new role when a domain fits well enough', async () => {
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    const role = await prisma.catalogProposal.findFirstOrThrow({ where: { kind: 'new_role' } });
    expect({ title: role.title, domainId: role.domainId, familyId: role.familyId, summary: role.summary }).toEqual({
      title: 'Software Quality Engineer', domainId: catalog.techId, familyId: catalog.engFamilyId, summary: 'Test software before release. Report defects.',
    });
  });

  it('skips an unmatched occupation no domain fits, and counts it', async () => {
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    const stats = JSON.parse((await latestRun()).statsJson) as { onet: { fetched: number; matchedExisting: number; proposed: number; skipped: number } };
    expect({ titles: (await proposalTitles()).includes('Farmworkers'), onet: stats.onet }).toMatchObject({ titles: false, onet: { fetched: 3, matchedExisting: 1, proposed: 4, skipped: 1 } });
  });

  it('skips a new role below the configured confidence threshold', async () => {
    configureCatalogRefresh({ minConfidence: 0.9 });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    expect(await prisma.catalogProposal.count({ where: { kind: 'new_role' } })).toBe(0);
  });

  it('records the source of every proposal with a link', async () => {
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    const role = await prisma.catalogProposal.findFirstOrThrow({ where: { kind: 'new_role' } });
    expect(JSON.parse(role.sourcesJson)).toEqual([{ source: 'onet', ref: '15-1253.00', url: 'https://www.onetonline.org/link/summary/15-1253.00', label: 'Software Quality Engineer' }]);
  });
});

describe('classification with a model', () => {
  it('uses the model\'s domain, family and confidence', async () => {
    const model = vi.fn(async () => [{ title: 'Farmworkers', domainId: catalog.healthId, familyId: catalog.careFamilyId, confidence: 0.8 }, { title: 'Software Quality Engineer', domainId: catalog.techId, familyId: null, confidence: 0.9 }]);
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { model, modelAvailable: true }).deps });
    const farm = await prisma.catalogProposal.findFirstOrThrow({ where: { title: 'Farmworkers' } });
    expect({ domainId: farm.domainId, familyId: farm.familyId, confidence: farm.confidence }).toEqual({ domainId: catalog.healthId, familyId: catalog.careFamilyId, confidence: 0.8 });
  });

  it('falls back instead of failing when the model returns ids that do not exist', async () => {
    const model = vi.fn(async () => [{ title: 'Software Quality Engineer', domainId: 'cjld2cjxh0000qzrmn831i7rn', familyId: 'cjld2cjxh0000qzrmn831i7ro', confidence: 0.99 }]);
    const result = await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { model, modelAvailable: true }).deps });
    const role = await prisma.catalogProposal.findFirstOrThrow({ where: { title: 'Software Quality Engineer' } });
    expect({ outcome: result.outcome, domainId: role.domainId, confidence: role.confidence }).toEqual({ outcome: 'ran', domainId: catalog.techId, confidence: 0.5 });
  });

  it('counts model calls on the run', async () => {
    const model = vi.fn(async () => []);
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { model, modelAvailable: true }).deps });
    expect((await latestRun()).llmCalls).toBe(model.mock.calls.length);
  });

  it('stops calling the model at the per-run cap', async () => {
    configureCatalogRefresh({ maxLlmCalls: 1 });
    const model = vi.fn(async () => []);
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { model, modelAvailable: true, onetChunkSize: 1 }).deps });
    expect({ calls: model.mock.calls.length, recorded: (await latestRun()).llmCalls }).toEqual({ calls: 1, recorded: 1 });
  });
});

describe('deduplication', () => {
  it('does not propose a title already pending review', async () => {
    await pendingProposal((await priorRun()).id, 'Application Developer', 'new_alias');
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    expect(await prisma.catalogProposal.count({ where: { normalizedTitle: 'application developer' } })).toBe(1);
  });

  it('does not propose a title rejected in the last 180 days', async () => {
    const rejected = await pendingProposal((await priorRun()).id, 'Code Writer', 'new_alias');
    await prisma.catalogProposal.update({ where: { id: rejected.id }, data: { status: 'rejected', reviewedAt: new Date(Date.now() - 179 * 86_400_000) } });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    expect(await prisma.catalogProposal.count({ where: { normalizedTitle: 'code writer' } })).toBe(1);
  });

  it('proposes again a title rejected more than 180 days ago', async () => {
    const rejected = await pendingProposal((await priorRun()).id, 'Code Writer', 'new_alias');
    await prisma.catalogProposal.update({ where: { id: rejected.id }, data: { status: 'rejected', reviewedAt: new Date(Date.now() - 181 * 86_400_000) } });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    expect(await prisma.catalogProposal.count({ where: { normalizedTitle: 'code writer', status: 'pending' } })).toBe(1);
  });

  it('does not propose a title that is already a retired catalog role', async () => {
    await prisma.catalogRole.create({ data: { domainId: catalog.techId, title: 'Software Quality Engineer', normalizedTitle: 'software quality engineer', source: 'seed', status: 'retired' } });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    expect(await prisma.catalogProposal.count({ where: { normalizedTitle: 'software quality engineer' } })).toBe(0);
  });

  it('proposes a title once when two sources both find it', async () => {
    const esco = [{ uri: 'http://data.europa.eu/esco/occupation/dev', title: 'software developer', alternatives: ['Software Engineer', 'Application Developer'] }];
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({ esco }).deps });
    expect(await prisma.catalogProposal.count({ where: { normalizedTitle: 'application developer' } })).toBe(1);
  });
});

describe('the per-run proposal cap', () => {
  it('keeps aliases before new roles across all sources', async () => {
    configureCatalogRefresh({ maxProposals: 3 });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    expect((await prisma.catalogProposal.findMany({ select: { kind: true } })).map((p) => p.kind)).toEqual(['new_alias', 'new_alias', 'new_alias']);
  });

  it('keeps the most confident proposals when capped', async () => {
    configureCatalogRefresh({ maxProposals: 2 });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    expect(await proposalTitles()).toEqual(['Application Developer', 'Software Developers']);
  });

  it('applies one cap to the whole run, not to each chunk', async () => {
    configureCatalogRefresh({ maxProposals: 2 });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { onetChunkSize: 1 }).deps });
    expect(await prisma.catalogProposal.count()).toBe(2);
  });

  it('counts capped proposals as skipped', async () => {
    configureCatalogRefresh({ maxProposals: 2 });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    const stats = JSON.parse((await latestRun()).statsJson) as { onet: { proposed: number; skipped: number } };
    expect(stats.onet).toMatchObject({ proposed: 2, skipped: 3 });
  });
});

describe('resuming an interrupted run', () => {
  it('resumes from the saved cursor without duplicates and completes', async () => {
    let chunks = 0;
    const crashAfterFirst = async () => { chunks += 1; if (chunks === 1) throw new Error('process killed'); };
    const first = await runCatalogRefresh({ trigger: 'schedule', deps: testDeps({}, { onetChunkSize: 1, afterChunk: crashAfterFirst }).deps });
    const afterCrash = await latestRun();
    const second = await runCatalogRefresh({ trigger: 'schedule', deps: testDeps({}, { onetChunkSize: 1 }).deps });
    const titles = await proposalTitles();
    expect({
      first: first.outcome,
      crashedStatus: afterCrash.status,
      sameRun: second.runId === first.runId,
      finalStatus: (await latestRun()).status,
      duplicates: titles.length - new Set(titles).size,
      titles,
    }).toEqual({
      first: 'failed', crashedStatus: 'failed', sameRun: true, finalStatus: 'completed', duplicates: 0,
      titles: ['Application Developer', 'Code Writer', 'Software Developers', 'Software Quality Engineer'],
    });
  });

  it('does not re-read chunks it had finished', async () => {
    let chunks = 0;
    const crashAfterFirst = async () => { chunks += 1; if (chunks === 1) throw new Error('process killed'); };
    await runCatalogRefresh({ trigger: 'schedule', deps: testDeps({}, { onetChunkSize: 1, afterChunk: crashAfterFirst }).deps });
    const offsetsSaved: number[] = [];
    const recordOffset = async () => { offsetsSaved.push((JSON.parse((await latestRun()).cursorJson) as { onet: { offset: number } }).onet.offset); };
    await runCatalogRefresh({ trigger: 'schedule', deps: testDeps({}, { onetChunkSize: 1, afterChunk: recordOffset }).deps });
    const stats = JSON.parse((await latestRun()).statsJson) as { onet: { fetched: number } };
    // The first chunk after resuming ends at offset 2: occupation 0 was done before the crash.
    expect({ firstSavedOffset: offsetsSaved[0], fetched: stats.onet.fetched }).toEqual({ firstSavedOffset: 2, fetched: 3 });
  });
});

describe('a failing source', () => {
  it('is recorded while the other sources proceed and the run completes', async () => {
    const esco = [{ uri: 'http://data.europa.eu/esco/occupation/ds', title: 'data scientist', alternatives: ['Machine Learning Scientist'] }];
    const result = await runCatalogRefresh({ trigger: 'manual', deps: testDeps({ onetStatus: 503, esco }).deps });
    const run = await latestRun();
    const stats = JSON.parse(run.statsJson) as { onet: { errors: string[] } };
    expect({
      outcome: result.outcome,
      status: run.status,
      onetError: stats.onet.errors.some((e) => e.includes('503')),
      escoAlias: await prisma.catalogProposal.count({ where: { title: 'Machine Learning Scientist', targetRoleId: catalog.dsId } }),
    }).toEqual({ outcome: 'ran', status: 'completed', onetError: true, escoAlias: 1 });
  });
});

describe('ESCO', () => {
  const occupations = Array.from({ length: 30 }, (_, i) => ({ uri: `http://data.europa.eu/esco/occupation/o${i}`, title: `Occupation Number ${i}` }));

  it('pages from where the previous run stopped', async () => {
    configureCatalogRefresh({ escoLimit: 10, escoPagesPerRun: 1 });
    const { deps, requests } = testDeps({ esco: occupations });
    await runCatalogRefresh({ trigger: 'manual', deps });
    await runCatalogRefresh({ trigger: 'manual', deps });
    const offsets = requests.filter((r) => r.includes('/search') && r.includes('text=&')).map((r) => new URL(r).searchParams.get('offset'));
    expect(offsets).toEqual(['0', '10']);
  });

  it('wraps to the start after the last page', async () => {
    configureCatalogRefresh({ escoLimit: 25, escoPagesPerRun: 3 });
    const { deps, requests } = testDeps({ esco: occupations });
    await runCatalogRefresh({ trigger: 'manual', deps });
    await runCatalogRefresh({ trigger: 'manual', deps });
    const offsets = requests.filter((r) => r.includes('/search') && r.includes('text=&')).map((r) => new URL(r).searchParams.get('offset'));
    expect(offsets).toEqual(['0', '25', '0', '25']);
  });

  it('looks up existing roles by title and proposes their alternative labels', async () => {
    const esco = [{ uri: 'http://data.europa.eu/esco/occupation/nurse', title: 'registered nurse', alternatives: ['Staff Nurse', 'RN'] }];
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({ esco }).deps });
    const aliases = await prisma.catalogProposal.findMany({ where: { targetRoleId: catalog.nurseId }, orderBy: { title: 'asc' } });
    expect(aliases.map((a) => a.title)).toEqual(['RN', 'Staff Nurse']);
  });
});

describe('web research', () => {
  const reply = JSON.stringify([{ title: 'Agent Reliability Engineer', oneLineSummary: 'Keeps AI agents dependable.', evidenceUrls: ['https://a.test/1', 'https://b.test/2'] }]);

  it('proposes an evidenced title as a new role in the researched domain', async () => {
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({ research: reply }, { researchKey: 'sk-test' }).deps });
    const role = await prisma.catalogProposal.findFirstOrThrow({ where: { title: 'Agent Reliability Engineer' } });
    expect({ domainId: role.domainId, kind: role.kind, summary: role.summary }).toEqual({ domainId: catalog.techId, kind: 'new_role', summary: 'Keeps AI agents dependable.' });
  });

  it('makes one research call per domain and counts them', async () => {
    const { deps, requests } = testDeps({ research: reply }, { researchKey: 'sk-test' });
    await runCatalogRefresh({ trigger: 'manual', deps });
    expect({ requests: requests.filter((r) => r.includes('api.openai.com')).length, recorded: (await latestRun()).researchCalls }).toEqual({ requests: 2, recorded: 2 });
  });

  it('stops at the research call cap', async () => {
    configureCatalogRefresh({ researchMaxCalls: 1 });
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({ research: reply }, { researchKey: 'sk-test' }).deps });
    expect((await latestRun()).researchCalls).toBe(1);
  });

  it('skips without a key and records why, completing the run', async () => {
    const { deps, requests } = testDeps({ research: reply }, { researchKey: '' });
    await runCatalogRefresh({ trigger: 'manual', deps });
    const run = await latestRun();
    const stats = JSON.parse(run.statsJson) as { web: { skippedReason?: string } };
    expect({ status: run.status, reason: stats.web.skippedReason, calls: requests.filter((r) => r.includes('api.openai.com')).length }).toEqual({ status: 'completed', reason: 'no_openai_key', calls: 0 });
  });

  it('skips in a demo and records why', async () => {
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({ research: reply }, { researchKey: 'sk-test', demo: true }).deps });
    const stats = JSON.parse((await latestRun()).statsJson) as { web: { skippedReason?: string } };
    expect(stats.web.skippedReason).toBe('demo');
  });

  it('records a failed research call as an error and still completes', async () => {
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({ research: 500 }, { researchKey: 'sk-test' }).deps });
    const run = await latestRun();
    const stats = JSON.parse(run.statsJson) as { web: { errors: string[] } };
    expect({ status: run.status, errors: stats.web.errors.length, calls: run.researchCalls }).toEqual({ status: 'completed', errors: 2, calls: 2 });
  });
});
