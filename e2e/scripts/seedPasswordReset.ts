import { prisma } from '../../server/src/db.js';
import { hashPassword } from '../../server/src/services/auth.js';
import { generateResetToken, hashResetToken, RESET_TTL_MS } from '../../server/src/services/passwordReset.js';

/**
 * A throwaway account and a live reset link for it, for the reset spec.
 *
 * The link is minted here rather than read out of an email because there is no
 * email to read: the e2e stack runs the console mail provider, which delivers
 * nothing. What the browser then does with the link — check it, spend it, fail
 * to spend it twice — is the real code path either way, since the row this
 * writes is byte-for-byte what the "forgot password" route writes.
 *
 * Prints the account and the token as JSON for the spec.
 */

const tag = process.argv[2] ?? `${Date.now()}`;
const email = `e2e-reset-${tag}@questor.local`;
const oldPassword = `old-passphrase-${tag}`;

try {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { isDemo: false }, orderBy: { createdAt: 'asc' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email, name: `E2E Reset ${tag}`, passwordHash: hashPassword(oldPassword), role: 'recruiter' },
  });
  const token = generateResetToken();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashResetToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
  });
  console.log(JSON.stringify({ email, oldPassword, token, userId: user.id, slug: tenant.slug ?? '' }));
} finally {
  await prisma.$disconnect();
}
