import { readFileSync } from 'node:fs';
import { prisma } from '../../server/src/db.js';
import { resetTokenUsable, hashResetToken } from '../../server/src/services/passwordReset.js';

/** Throwaway diagnostic: is a seeded reset token usable against this database? */
const { token } = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { token: string };
const rows = await prisma.passwordResetToken.findMany({ select: { tokenHash: true, expiresAt: true, consumedAt: true, supersededAt: true } });
console.log(JSON.stringify({
  rows: rows.length,
  hashMatches: rows.filter((r) => r.tokenHash === hashResetToken(token)).length,
  usable: await resetTokenUsable(token),
}));
await prisma.$disconnect();
