import { prisma } from '../../server/src/db.js';

/**
 * Remove the throwaway accounts the password specs and the screenshot run
 * leave behind, so the People page shows a team rather than a pile of fixtures.
 *
 * Only ever the ones this repo's own scripts create, named by a prefix nothing
 * real uses. Their reset links and device grants go with them by cascade.
 */
const { count } = await prisma.user.deleteMany({
  where: { OR: [{ email: { startsWith: 'e2e-reset-' } }, { email: { startsWith: 'e2e-code-' } }] },
});
console.log(JSON.stringify({ removed: count }));
await prisma.$disconnect();
