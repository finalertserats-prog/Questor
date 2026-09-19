import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { _catalogRefreshSettled, _setCatalogRefreshDepsForTest } from '../src/services/catalogRefresh.js';
import { CATALOG_REFRESH_LEASE } from '../src/services/catalogRefreshRun.js';
import { configureCatalogRefresh, testDeps } from './catalogRefreshFixtures.js';
import { bearer, proposal, seedReviewWorld, type ReviewWorld } from './catalogReviewFixtures.js';

/** The review queue's read side, the manual run trigger, and the public attribution. */

const app = createApp();
let world: ReviewWorld;

beforeEach(async () => {
  configureCatalogRefresh();
  world = await seedReviewWorld();
  _setCatalogRefreshDepsForTest(testDeps({}).deps);
});

afterEach(async () => {
  await _catalogRefreshSettled();
  _setCatalogRefreshDepsForTest(null);
});

function list(query = '') {
  return request(app).get(`/api/catalog-review/proposals${query}`).set('Authorization', bearer(world.operator.token));
}

function titles(res: request.Response): string[] {
  return (res.body.proposals as { title: string }[]).map((p) => p.title).sort();
}

describe('listing proposals', () => {
  it('filters by status', async () => {
    await proposal(world, { title: 'Pending One' });
    await proposal(world, { title: 'Rejected One', status: 'rejected' });
    expect(titles(await list('?status=pending'))).toEqual(['Pending One']);
  });

  it('filters by kind', async () => {
    await proposal(world, { title: 'Role One' });
    await proposal(world, { kind: 'new_alias', title: 'Alias One' });
    expect(titles(await list('?kind=new_alias'))).toEqual(['Alias One']);
  });

  it('filters by domain', async () => {
    await proposal(world, { title: 'Tech Role' });
    await proposal(world, { title: 'Health Role', domainId: world.catalog.healthId });
    expect(titles(await list(`?domainId=${world.catalog.healthId}`))).toEqual(['Health Role']);
  });

  it('filters by source', async () => {
    await proposal(world, { title: 'From Onet' });
    await proposal(world, { title: 'From Web', sources: [{ source: 'web', ref: 'https://a.test/1', url: 'https://a.test/1' }] });
    expect(titles(await list('?source=web'))).toEqual(['From Web']);
  });

  it('refuses a source outside the known list', async () => {
    expect((await list('?source=%22%2C%22x')).status).toBe(400);
  });

  it('searches titles ignoring case and punctuation', async () => {
    await proposal(world, { title: 'Agent-Reliability Engineer' });
    await proposal(world, { title: 'Wound Care Nurse' });
    expect(titles(await list('?q=AGENT%20reliability'))).toEqual(['Agent-Reliability Engineer']);
  });

  it('searches summaries too', async () => {
    await proposal(world, { title: 'Wound Care Nurse', summary: 'Treats chronic wounds in clinics.' });
    await proposal(world, { title: 'Agent Reliability Engineer' });
    expect(titles(await list('?q=chronic'))).toEqual(['Wound Care Nurse']);
  });

  it('refuses unknown query parameters', async () => {
    expect((await list('?sort=title')).status).toBe(400);
  });

  it('refuses a limit above 100', async () => {
    expect((await list('?limit=101')).status).toBe(400);
  });

  it('pages with totals', async () => {
    for (let i = 0; i < 5; i += 1) await proposal(world, { title: `Paged Role ${String.fromCharCode(65 + i)}`, createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)) });
    const res = await list('?limit=2&page=3');
    expect({ meta: res.body.meta, titles: titles(res) }).toEqual({ meta: { total: 5, page: 3, limit: 2, totalPages: 3, pendingTotal: 5 }, titles: ['Paged Role A'] });
  });

  it('returns domain, family, target role and sources for each proposal', async () => {
    await proposal(world, { kind: 'new_alias', title: 'Application Developer' });
    const [p] = (await list()).body.proposals;
    expect({ domain: p.domain, target: p.targetRole, sources: p.sources }).toEqual({
      domain: null,
      target: { id: world.catalog.sweId, title: 'Software Engineer', status: 'active' },
      sources: [{ source: 'onet', ref: '15-1252.00', url: 'https://www.onetonline.org/link/summary/15-1252.00', label: 'Software Developers' }],
    });
  });

  it('never returns a source link that is not http(s)', async () => {
    await proposal(world, { title: 'Sneaky', sources: [{ source: 'web', ref: 'x', url: 'javascript:alert(1)' }] });
    const [p] = (await list()).body.proposals;
    expect(p.sources).toEqual([{ source: 'web', ref: 'x' }]);
  });
});

describe('edit options', () => {
  it('lists active domains with the families their roles use', async () => {
    const res = await request(app).get('/api/catalog-review/options').set('Authorization', bearer(world.operator.token));
    expect(res.body.domains).toEqual([
      { id: world.catalog.techId, name: 'Technology', families: [{ id: world.catalog.engFamilyId, name: 'Engineering' }] },
      { id: world.catalog.healthId, name: 'Healthcare', families: [{ id: world.catalog.careFamilyId, name: 'Care' }] },
    ]);
  });

  it('is for operators only', async () => {
    const res = await request(app).get('/api/catalog-review/options').set('Authorization', bearer(world.admin.token));
    expect(res.status).toBe(403);
  });
});

describe('recent runs', () => {
  it('lists the latest runs with their stats, newest first', async () => {
    await prisma.catalogRefreshRun.create({ data: { trigger: 'schedule', status: 'completed', startedAt: new Date(Date.UTC(2026, 7, 1)), statsJson: JSON.stringify({ onet: { fetched: 9, matchedExisting: 1, proposed: 2, skipped: 6, errors: [] } }) } });
    const res = await request(app).get('/api/catalog-review/runs').set('Authorization', bearer(world.operator.token));
    const oldest = res.body.runs[res.body.runs.length - 1];
    expect({ count: res.body.runs.length, active: res.body.active, fetched: oldest.stats.onet.fetched, escoDefault: oldest.stats.esco.fetched }).toEqual({ count: 2, active: false, fetched: 9, escoDefault: 0 });
  });

  it('shows at most 20 runs', async () => {
    await prisma.catalogRefreshRun.createMany({ data: Array.from({ length: 25 }, () => ({ trigger: 'schedule', status: 'completed' })) });
    const res = await request(app).get('/api/catalog-review/runs').set('Authorization', bearer(world.operator.token));
    expect(res.body.runs).toHaveLength(20);
  });
});

describe('starting a run by hand over HTTP', () => {
  function start() {
    return request(app).post('/api/catalog-review/runs').set('Authorization', bearer(world.operator.token)).send({});
  }

  it('answers 202 with the run id', async () => {
    const res = await start();
    expect({ status: res.status, hasId: typeof res.body.runId === 'string' }).toEqual({ status: 202, hasId: true });
  });

  it('answers before the run finishes', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    _setCatalogRefreshDepsForTest(testDeps({}, { afterChunk: () => gate }).deps);
    const res = await start();
    const run = await prisma.catalogRefreshRun.findUniqueOrThrow({ where: { id: res.body.runId } });
    release();
    expect({ status: res.status, runStatus: run.status }).toEqual({ status: 202, runStatus: 'running' });
  });

  it('records the operator as the trigger', async () => {
    const res = await start();
    await _catalogRefreshSettled();
    const run = await prisma.catalogRefreshRun.findUniqueOrThrow({ where: { id: res.body.runId } });
    expect({ trigger: run.trigger, by: run.triggeredById }).toEqual({ trigger: 'manual', by: world.operator.id });
  });

  it('answers 409 while a run holds the lease', async () => {
    await prisma.jobLease.create({ data: { name: CATALOG_REFRESH_LEASE.name, holder: 'other-host:1:abc', expiresAt: new Date(Date.now() + 60_000) } });
    const res = await start();
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'already_running' });
  });

  it('is rate limited', async () => {
    // The limiter is off under nodeEnv 'test'; this test is about the limiter.
    const originalNodeEnv = config.nodeEnv;
    (config as { nodeEnv: string }).nodeEnv = 'development';
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 7; i += 1) {
        statuses.push((await start()).status);
        await _catalogRefreshSettled();
      }
    } finally {
      (config as { nodeEnv: string }).nodeEnv = originalNodeEnv;
    }
    expect(statuses[6]).toBe(429);
  });
});

describe('public attribution', () => {
  it('lists the O*NET and ESCO attributions without signing in', async () => {
    const res = await request(app).get('/api/catalog/sources');
    expect(res.body.sources.map((s: { name: string }) => s.name)).toEqual(['O*NET', 'ESCO']);
  });

  it('carries the exact O*NET wording the licence requires', async () => {
    const res = await request(app).get('/api/catalog/sources');
    expect(res.body.sources[0].text).toBe('This site incorporates information from O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET® is a trademark of USDOL/ETA.');
  });

  it('links each attribution to its licence or source', async () => {
    const res = await request(app).get('/api/catalog/sources');
    expect(res.body.sources.map((s: { url: string }) => s.url)).toEqual(['https://creativecommons.org/licenses/by/4.0/', 'https://esco.ec.europa.eu/']);
  });
});
