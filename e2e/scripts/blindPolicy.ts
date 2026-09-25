// Turn the organisation's blind-review requirement on or off, for a visual
// check of the masked competency cards. Usage:
//   DATABASE_URL=file:./data/questor.db npx tsx e2e/scripts/blindPolicy.ts on|off
//
// Development only. It writes the same policy key the admin console writes
// (routes/admin.ts, requireBlindReview), so the page under the camera is the
// page a real organisation would see.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const want = process.argv[2] === 'on';

async function main() {
  const user = await prisma.user.findFirstOrThrow({
    where: { email: process.env.SEED_OWNER_EMAIL ?? 'demo@questor.local' },
    select: { tenantId: true },
  });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { policyJson: true } });
  const policy = { ...JSON.parse(tenant.policyJson || '{}'), requireBlindReview: want };
  await prisma.tenant.update({ where: { id: user.tenantId }, data: { policyJson: JSON.stringify(policy) } });
  console.log(`requireBlindReview: ${want}`);
}

main().finally(() => prisma.$disconnect());
