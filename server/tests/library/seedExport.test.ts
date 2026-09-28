import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { exportSeedPools, seedPoolsFileSchema } from '../../src/library/seedExport.js';
import { BAND, entry, seedLibraryWorld, type LibraryWorld } from './libraryFixtures.js';

/**
 * The pool export the laptop generator writes from. Owner decision 2026-09-22:
 * only global-catalog text leaves the server. A pool is exported only when its
 * competency is one of the platform's own, and then with the platform's
 * wording, never the organisation's scorecard definition or indicators.
 */

let world: LibraryWorld;

const ORG_DEFINITION = 'Acme-internal: speaks at our Thursday settlement huddle';
const ORG_INDICATOR = 'Presents the Acme ledger dashboard to the CFO';
const ORG_ONLY_NAME = 'Acme Ledger Stewardship';

/** The tenant role's scorecard: two platform competencies worded by the organisation, and one of its own. */
async function mixedScorecard(): Promise<void> {
  const competencies = [
    { id: 'p1', name: 'Communication', definition: ORG_DEFINITION, indicators: [ORG_INDICATOR] },
    { id: 'p2', name: 'Data Modeling', definition: 'Our ledger schema, the Acme way.', indicators: ['Knows the Acme posting tables'] },
    { id: 'o1', name: ORG_ONLY_NAME, definition: 'Keeps the Acme ledger tidy.', indicators: ['Owns the month-end tidy-up'] },
  ].map((c) => ({ ...c, category: 'technical', classification: 'essential', weight: 1 / 3, requiredLevel: 3, targetLevel: 4, evidenceModes: [] }));
  const profile = {
    roleContext: 'Payments', outcomes: [], responsibilities: [], competencies,
    scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: '' },
    redFlags: [], seniority: 'senior',
  };
  await prisma.roleScorecardVersion.updateMany({ where: { roleId: world.roleId }, data: { profileJson: JSON.stringify(profile) } });
}

/** An entry the offline seed wrote from exported (global) text. */
async function seededEntry(overrides: { readonly status?: string; readonly form?: string } = {}) {
  const row = await entry(world, { competencyKey: 'communication', ...overrides });
  return prisma.libraryEntry.update({ where: { id: row.id }, data: { createdBy: 'brahmastra' } });
}

beforeEach(async () => {
  world = await seedLibraryWorld();
  await mixedScorecard();
});

describe('what leaves the server', () => {
  it('exports only pools whose competency is a platform competency', async () => {
    expect((await exportSeedPools()).pools.map((p) => p.competencyKey).sort()).toEqual(['communication', 'data-modeling']);
  });

  it("never carries an organisation's own competency", async () => {
    expect(JSON.stringify(await exportSeedPools())).not.toContain(ORG_ONLY_NAME);
  });

  it("never carries an organisation's definition of a platform competency", async () => {
    expect(JSON.stringify(await exportSeedPools())).not.toContain(ORG_DEFINITION);
  });

  it("never carries an organisation's indicators", async () => {
    expect(JSON.stringify(await exportSeedPools())).not.toContain(ORG_INDICATOR);
  });

  it("never carries the organisation's name anywhere", async () => {
    expect(JSON.stringify(await exportSeedPools())).not.toMatch(/acme/i);
  });

  it('uses the platform wording for a platform competency', async () => {
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === 'communication');
    expect(pool?.competency.definition).toBe('Explains complex ideas clearly, listens actively and adapts to the audience.');
  });

  it("never carries an organisation's own job description", async () => {
    expect(JSON.stringify(await exportSeedPools())).not.toContain('marketplaces');
  });

  it('never carries a catalog role an organisation typed in', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { id: world.roleId }, select: { catalogRoleId: true } });
    await prisma.catalogRole.update({ where: { id: role.catalogRoleId! }, data: { createdByTenantId: world.admin.tenantId, source: 'org' } });
    expect((await exportSeedPools()).pools).toEqual([]);
  });

  it('counts the pools it left behind, without naming them', async () => {
    expect((await exportSeedPools()).skippedOrgCompetencyPools).toBe(1);
  });
});

describe('exportSeedPools', () => {
  it('keeps only the roles asked for', async () => {
    expect((await exportSeedPools({ roles: ['some-other-role'] })).pools).toEqual([]);
  });

  it('keeps only the bands asked for', async () => {
    expect((await exportSeedPools({ bands: ['senior'] })).pools).toEqual([]);
  });

  it('carries the seeded questions already in the pool so the generator avoids them', async () => {
    const existing = await seededEntry();
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === 'communication');
    expect(pool?.existingQuestions).toContain(existing.questionText);
  });

  it("never carries a question the server's worker wrote, which may echo an organisation's scorecard wording", async () => {
    await entry(world, { competencyKey: 'communication', questionText: 'How would you present the ledger dashboard to the CFO at our Thursday huddle?' });
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === 'communication');
    expect(pool?.existingQuestions).toEqual([]);
  });

  it("never carries an organisation's private questions", async () => {
    await entry(world, { competencyKey: 'communication', scope: 'org', tenantId: world.admin.tenantId, questionText: 'Private question about our own settlement stack?' });
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === 'communication');
    expect(pool?.existingQuestions).toEqual([]);
  });

  it('counts forms of entries still waiting for the owner, so the next batch asks for other forms', async () => {
    await entry(world, { competencyKey: 'communication', status: 'draft', form: 'star' });
    await seededEntry({ status: 'probational', form: 'opinion' });
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === 'communication');
    expect(pool?.formCounts).toEqual({ star: 1, opinion: 1 });
  });

  it("never carries a standard the server's worker wrote", async () => {
    await prisma.libraryStandard.create({ data: { familySlug: world.familySlug, competencyKey: 'communication', band: BAND, generatorModel: 'gpt-5', anchorsJson: JSON.stringify({ anchors: ['Presents the Acme ledger dashboard', 'Second anchor here'], weakSigns: [] }) } });
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === 'communication');
    expect(pool?.standard).toBeNull();
  });

  it('carries the live family standard when the seed run wrote it', async () => {
    await prisma.libraryStandard.create({ data: { familySlug: world.familySlug, competencyKey: 'communication', band: BAND, generatorModel: 'brahmastra:codex', anchorsJson: JSON.stringify({ anchors: ['First anchor here', 'Second anchor here'], weakSigns: [] }) } });
    const pool = (await exportSeedPools()).pools.find((p) => p.competencyKey === 'communication');
    expect(pool?.standard?.anchors).toEqual(['First anchor here', 'Second anchor here']);
  });

  it('writes a file the laptop side can validate', async () => {
    expect(seedPoolsFileSchema.safeParse(JSON.parse(JSON.stringify(await exportSeedPools()))).success).toBe(true);
  });

  it('caps the number of pools', async () => {
    expect((await exportSeedPools({ limit: 1 })).pools.length).toBe(1);
  });
});
