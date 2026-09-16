import { prisma } from '../../server/src/db.js';

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