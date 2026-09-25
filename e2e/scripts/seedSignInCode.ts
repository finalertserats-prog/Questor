import { prisma } from '../../server/src/db.js';
import { hashPassword } from '../../server/src/services/auth.js';
import { hashCode } from '../../server/src/services/signInCode.js';

/**
 * Two errands for anything that has to get past the sign-in code step.
 *
 *   setup <tag>     a throwaway organisation whose policy asks everyone for a
 *                   code, with one account in it
 *   code <email>    replace the newest live challenge for that account with the
 *                   hash of a code the caller knows
 *
 * The second is the only way to read a code here: the e2e stack runs the
 * console mail provider, which delivers nothing, and what is stored is an HMAC
 * under the server pepper — which is exactly the property being relied on.
 * Everything else in the flow runs as written: the ticket, the attempt counter,
 * the single use, the lockout.
 */

const [errand, argument = `${Date.now()}`] = process.argv.slice(2);
const KNOWN_CODE = '424242';

try {
  if (errand === 'setup') {
    const email = `e2e-code-${argument}@questor.local`;
    const password = `code-passphrase-${argument}`;
    const slug = `e2e-code-${argument}`.slice(0, 40);
    const tenant = await prisma.tenant.create({
      data: { name: `E2E Code Org ${argument}`, slug, policyJson: JSON.stringify({ mfaPolicy: 'everyone' }) },
    });
    await prisma.user.create({
      data: { tenantId: tenant.id, email, name: `E2E Code ${argument}`, passwordHash: hashPassword(password), role: 'recruiter' },
    });
    console.log(JSON.stringify({ email, password, slug, code: KNOWN_CODE }));
  } else if (errand === 'code') {
    const email = argument.includes('@') ? argument : `e2e-code-${argument}@questor.local`;
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const challenge = await prisma.signInChallenge.findFirstOrThrow({
      where: { userId: user.id, consumedAt: null, supersededAt: null, lockedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.signInChallenge.update({
      where: { id: challenge.id },
      data: { codeHash: hashCode(challenge.id, KNOWN_CODE) },
    });
    console.log(JSON.stringify({ code: KNOWN_CODE }));
  } else {
    throw new Error(`Unknown errand: ${errand}`);
  }
} finally {
  await prisma.$disconnect();
}
