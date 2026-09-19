import { prisma } from '../../server/src/db.js';
import { normalizeTitle } from '../../server/src/domain/catalogText.js';

/**
 * Put a small, uniquely named review queue in front of the e2e operator
 * (demo@questor.local, named in PLATFORM_OPERATOR_EMAILS by dev-server.mjs):
 * four new roles and one alternative title from a completed refresh run.
 * Prints the titles and the domain as JSON for the spec.
 */

const suffix = process.argv[2] ?? `${Date.now()}`;

try {
  // A domain whose roles use a family, so an approval with that family is valid.
  const withFamily = await prisma.catalogRole.findFirstOrThrow({
    where: { status: 'active', familyId: { not: null }, domain: { status: 'active' } },
    orderBy: [{ domain: { sortOrder: 'asc' } }, { title: 'asc' }],
    select: { id: true, domainId: true, familyId: true, domain: { select: { name: true } } },
  });
  const run = await prisma.catalogRefreshRun.create({
    data: { status: 'completed', trigger: 'manual', finishedAt: new Date(), statsJson: JSON.stringify({ onet: { fetched: 5, matchedExisting: 1, proposed: 5, skipped: 0, errors: [] } }) },
  });
  const titles = {
    edit: `E2E Catalog Draft ${suffix}`,
    reject: `E2E Catalog Reject ${suffix}`,
    bulkA: `E2E Catalog Bulk A ${suffix}`,
    bulkB: `E2E Catalog Bulk B ${suffix}`,
    alias: `E2E Catalog Alias ${suffix}`,
  };
  const sources = JSON.stringify([{ source: 'onet', ref: '15-1252.00', url: 'https://www.onetonline.org/link/summary/15-1252.00', label: 'Software Developers' }]);
  for (const title of [titles.edit, titles.reject, titles.bulkA, titles.bulkB]) {
    await prisma.catalogProposal.create({
      data: { runId: run.id, kind: 'new_role', title, normalizedTitle: normalizeTitle(title), domainId: withFamily.domainId, familyId: withFamily.familyId, summary: 'Seeded for the catalog review end-to-end test.', sourcesJson: sources, confidence: 0.9 },
    });
  }
  await prisma.catalogProposal.create({
    data: { runId: run.id, kind: 'new_alias', title: titles.alias, normalizedTitle: normalizeTitle(titles.alias), domainId: withFamily.domainId, targetRoleId: withFamily.id, sourcesJson: sources, confidence: 0.8 },
  });
  console.log(JSON.stringify({ suffix, titles, domainName: withFamily.domain.name }));
} finally {
  await prisma.$disconnect();
}
