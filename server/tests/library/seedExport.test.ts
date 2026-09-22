import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { exportSeedPools, seedPoolsFileSchema } from '../../src/library/seedExport.js';
import { BAND, entry, seedLibraryWorld, type LibraryWorld } from './libraryFixtures.js';

/** The pool export the laptop generator writes from: shared text only, below-target pools only. */

let world: LibraryWorld;

beforeEach(async () => {
  world = await seedLibraryWorld();
});

describe('exportSeedPools', () => {
  it('exports one pool per scored competency below target', async () => {
    expect((await exportSeedPools()).pools.length).toBe(2);
  });

  it('keeps only the roles asked for', async () => {
    expect((await exportSeedPools({ roles: ['some-other-role'] })).pools).toEqual([]);
  });

  it('keeps only the bands asked for', async () => {
    expect((await exportSeedPools({ bands: ['senior'] })).pools).toEqual([]);
  });

  it("never carries an organisation's own job description", async () => {
    const file = await exportSeedPools();
    expect(JSON.stringify(file)).not.toContain('marketplaces');
  });

  it('carries the questions already in the pool so the generator avoids them', async () => {
    const existing = await entry(world, { competencyKey: world.competencyKeys[0] });
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === world.competencyKeys[0]);
    expect(pool?.existingQuestions).toContain(existing.questionText);
  });

  it("never carries an organisation's private questions", async () => {
    await entry(world, { competencyKey: world.competencyKeys[0], scope: 'org', tenantId: world.admin.tenantId, questionText: 'Private question about our own settlement stack?' });
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === world.competencyKeys[0]);
    expect(pool?.existingQuestions).toEqual([]);
  });

  it('counts forms of entries still waiting for the owner, so the next batch asks for other forms', async () => {
    await entry(world, { competencyKey: world.competencyKeys[0], status: 'draft', form: 'star' });
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === world.competencyKeys[0]);
    expect(pool?.formCounts).toEqual({ star: 1 });
  });

  it('carries the live family standard when there is one', async () => {
    await prisma.libraryStandard.create({ data: { familySlug: world.familySlug, competencyKey: world.competencyKeys[0], band: BAND, anchorsJson: JSON.stringify({ anchors: ['First anchor here', 'Second anchor here'], weakSigns: [] }) } });
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === world.competencyKeys[0]);
    expect(pool?.standard?.anchors).toEqual(['First anchor here', 'Second anchor here']);
  });

  it('writes a file the laptop side can validate', async () => {
    expect(seedPoolsFileSchema.safeParse(JSON.parse(JSON.stringify(await exportSeedPools()))).success).toBe(true);
  });

  it('caps the number of pools', async () => {
    expect((await exportSeedPools({ limit: 1 })).pools.length).toBe(1);
  });
});
