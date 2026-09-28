import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { selectLadders } from '../../src/library/select.js';
import { seededRandom } from '../../src/library/sample.js';
import { BAND, entry, seedLibraryWorld, type LibraryWorld } from './libraryFixtures.js';

/** What L1 adds to select: CV-led lean, a candidate's own history excluded, built-in usage rows ignored. */

let world: LibraryWorld;

beforeEach(async () => {
  world = await seedLibraryWorld();
});

function request(overrides: Partial<Parameters<typeof selectLadders>[0]> = {}) {
  return selectLadders({
    tenantId: world.admin.tenantId, roleSlug: world.roleSlug, band: BAND, competencyKeys: [world.competencyKeys[0]],
    includeProbational: false, windowDays: 30, rng: seededRandom(1), ...overrides,
  });
}

describe('selectLadders (L1)', () => {
  it('never offers an entry the candidate was already asked', async () => {
    const asked = await entry(world, { difficultyTag: 1, form: 'star' });
    await entry(world, { difficultyTag: 1, form: 'opinion' });
    await entry(world, { difficultyTag: 2, form: 'tradeoff' });
    await entry(world, { difficultyTag: 3, form: 'walkthrough' });
    const ladders = await request({ excludeEntryIds: [asked.id] });
    expect(ladders[world.competencyKeys[0]].map((r) => r.entryId)).not.toContain(asked.id);
  });

  it('draws a harder ladder for a competency the CV shows strongly', async () => {
    await entry(world, { difficultyTag: 1, form: 'star' });
    await entry(world, { difficultyTag: 2, form: 'star' });
    await entry(world, { difficultyTag: 3, form: 'opinion' });
    const ladders = await request({ cvSignals: { [world.competencyKeys[0]]: 'strong' } });
    expect(ladders[world.competencyKeys[0]].map((r) => r.difficultyTag)).toEqual([2, 3]);
  });

  it('ignores usage rows of built-in blocks', async () => {
    await entry(world, { difficultyTag: 1, form: 'star' });
    await entry(world, { difficultyTag: 3, form: 'opinion' });
    await prisma.libraryUsage.create({ data: { entryId: null, interviewSessionId: 's-builtin', tenantId: world.admin.tenantId, roleSlug: world.roleSlug, blockSource: 'builtin' } });
    const ladders = await request();
    expect(ladders[world.competencyKeys[0]].length).toBe(2);
  });
});
