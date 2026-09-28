import { prisma } from '../../server/src/db.js';

/**
 * The shape the e2e suite signs in against: the first tenant is "acme".
 *
 * Whether it asks for a sign-in code is decided by the seed itself
 * (server/src/seed/demoData.ts sets mfaPolicy 'off', because nothing in this
 * stack can deliver an email), and deliberately not here as well: a fixture
 * that relaxed a security setting from two places would be one nobody could
 * reason about later.
 */
async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('No tenant found. Run the server seed before e2e tests.');
  if (tenant.slug !== 'acme') {
    await prisma.tenant.update({ where: { id: tenant.id }, data: { slug: 'acme' } });
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
