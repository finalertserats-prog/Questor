import { prisma } from '../../server/src/db.js';
import { hashDemoToken, hashRequestIp, mintDemoToken, provisionDemoTenant } from '../../server/src/services/demoAccess.js';

/**
 * Prints a fresh one-time demo link token for the audit run. The real flow
 * emails it; the console email provider only logs it inside the dev server,
 * where a test cannot read it. Everything else — the grant, the sandbox, the
 * redeem — is the production code path.
 */
async function main() {
  const email = `audit-${Date.now()}@questor.local`;
  const token = mintDemoToken();
  const provisioned = await provisionDemoTenant({ name: 'Audit Visitor', email, company: 'Audit Co' });
  await prisma.demoGrant.create({
    data: {
      name: 'Audit Visitor', email, company: 'Audit Co', status: 'sent',
      linkTokenHash: hashDemoToken(token), linkExpiresAt: new Date(Date.now() + 60 * 60_000),
      tenantId: provisioned.tenantId, userId: provisioned.userId, requestIpHash: hashRequestIp('127.0.0.1'),
    },
  });
  process.stdout.write(token);
}

main().finally(async () => { await prisma.$disconnect(); });
