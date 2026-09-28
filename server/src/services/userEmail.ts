import { prisma } from '../db.js';

/**
 * The one spelling of a sign-in address that is stored and compared.
 *
 * Signup lowercased while register and admin-create stored what was typed, so
 * one mailbox could hold two accounts, or an account could not sign in unless
 * its owner remembered the capitalisation an admin happened to use.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The user whose address matches, ignoring case.
 *
 * Exact lowercase first: every row written since normalisation matches there,
 * through the unique index. Rows stored in mixed case before that are found by
 * comparing lower(email), which SQLite and Postgres both support (Prisma's
 * `mode: 'insensitive'` is Postgres-only). Two legacy rows differing only in
 * case are ambiguous, and neither is returned rather than guessing.
 */
export async function findUserByEmail(email: string) {
  const normalized = normalizeEmail(email);
  const exact = await prisma.user.findUnique({ where: { email: normalized } });
  if (exact) return exact;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE lower("email") = ${normalized} LIMIT 2`;
  if (rows.length !== 1) return null;
  return prisma.user.findUnique({ where: { id: rows[0].id } });
}
