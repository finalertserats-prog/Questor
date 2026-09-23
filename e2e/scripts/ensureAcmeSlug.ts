import { prisma } from '../../server/src/db.js';

/**
 * The shape the e2e suite signs in against: the first tenant is "acme", and it
 * does not ask for a sign-in code.
 *
 * The code step is switched off HERE rather than in the product, and only for
 * this one organisation, because the e2e stack runs the console mail provider
 * — it delivers nothing, so a code nobody can read would lock every spec out
 * at the first step. The code step itself is covered by signInCode.spec.ts,
 * which turns it on for its own throwaway organisation and reads the code the
 * only way anything can: out of the database, by replacing it with a known one.
 */
async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('No tenant found. Run the server seed before e2e tests.');
  const policy = JSON.parse(tenant.policyJson || '{}') as Record<string, unknown>;
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      ...(tenant.slug === 'acme' ? {} : { slug: 'acme' }),
      policyJson: JSON.stringify({ ...policy, mfaPolicy: 'off' }),
    },
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
