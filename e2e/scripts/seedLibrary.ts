import { prisma } from '../../server/src/db.js';
import { slugifyCatalogName } from '../../server/src/domain/catalogText.js';

/**
 * Put a small library in front of the e2e operator (demo@questor.local): one
 * pool with four live entries across four forms (a ladder can be drawn), a
 * thin pool with one live entry (no ladder), and two drafts in the owner
 * queue. Prints the slugs and ids as JSON for the spec. Idempotent per tag.
 */

const tag = process.argv[2] ?? `${Date.now()}`;
const roleSlug = `e2e-library-role-${tag}`;
const thinSlug = `e2e-library-thin-${tag}`;
const band = 'established';
const competencyKey = slugifyCatalogName('Incident Ownership');

function row(slug: string, form: string, status: string, difficultyTag: number, n: number) {
  return {
    scope: 'global', roleSlug: slug, familySlug: 'engineering', competencyKey, band, form,
    questionText: `E2E ${status} ${form} question ${n} for ${slug}: walk me through the last incident you owned?`,
    bodyJson: JSON.stringify({ anchors: ['Names the failure mode', 'Says what changed after'] }),
    status, gateOutcome: status === 'draft' ? 'unsure' : 'pass', gateReason: status === 'draft' ? 'stratum:new' : '',
    stratumKey: `global|${slug}|${band}|${form}|library-gen-v1`, difficultyTag,
    generatorPromptVersion: 'library-gen-v1', generatorModel: 'seed', criticModel: 'seed',
    criticVerdictJson: JSON.stringify({ realQuestion: true, rightBand: true, answerable: true, formCorrect: true, anchorsLeaked: false, roleSpecific: true, confidence: 0.9, notes: '' }),
  };
}

try {
  const forms = ['star', 'opinion', 'tradeoff', 'walkthrough'];
  for (const [i, form] of forms.entries()) await prisma.libraryEntry.create({ data: row(roleSlug, form, 'live', (i % 3) + 1, i) });
  await prisma.libraryEntry.create({ data: row(thinSlug, 'star', 'live', 2, 0) });
  const draftA = await prisma.libraryEntry.create({ data: row(roleSlug, 'retrospective', 'draft', 2, 10) });
  const draftB = await prisma.libraryEntry.create({ data: row(roleSlug, 'hypothetical', 'draft', 3, 11) });
  await prisma.libraryPoolTarget.upsert({
    where: { scope_tenantId_roleSlug_competencyKey_band: { scope: 'global', tenantId: '', roleSlug, competencyKey, band } },
    create: { scope: 'global', tenantId: '', roleSlug, competencyKey, band, depthTarget: 12 },
    update: { depthTarget: 12 },
  });
  console.log(JSON.stringify({ tag, roleSlug, thinSlug, band, competencyKey, draftA: draftA.id, draftB: draftB.id }));
} finally {
  await prisma.$disconnect();
}
