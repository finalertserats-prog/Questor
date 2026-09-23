import { prisma } from '../../server/src/db.js';
import { hashPassword } from '../../server/src/services/auth.js';
import { hashCode } from '../../server/src/services/signInCode.js';

/**
 * Two errands for the sign-in-code spec, chosen by the first argument.
 *
 * `setup` makes a throwaway organisation whose policy asks everyone for a code,
 * with one account in it.
 *
 * `code` replaces the newest live challenge's stored hash with the hash of a
 * code the spec knows. That is the only way to read a code in the e2e stack:
 * the console mail provider delivers nothing, and what is stored is an HMAC
 * under the server pepper, which is exactly the property being relied on.
 * Everything else in the flow — the ticket, the attempt counter, the single
 * use, the lockout — runs as written.
 */

const [errand, tag = `${Date.now()}`] = process.argv.slice(2);
const email = `e2e-code-${tag}@questor.local`;
const password = `code-passphrase-${tag}`;
const slug = `e2e-code-${tag}`.slice(0, 40);
const KNOWN_CODE = '424242';

try {
  if (errand === 'setup') {
    const tenant = await prisma.tenant.create({
      data: { name: `E2E Code Org ${tag}`, slug, policyJson: JSON.stringify({ mfaPolicy: 'everyone' }) },
    });
    await prisma.user.create({
      data: { tenantId: tenant.id, email, name: `E2E Code ${tag}`, passwordHash: hashPassword(password), role: 'recruiter' },
    });
    console.log(JSON.stringify({ email, password, slug, code: KNOWN_CODE }));
  } else if (errand === 'code') {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: `e2e-code-${tag}@questor.local` } });
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
