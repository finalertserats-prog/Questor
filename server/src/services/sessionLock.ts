import { prisma } from '../db.js';

export type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Queue writers to one interview session behind its row lock.
 *
 * SQLite serialises writers, so read-then-write is already safe there.
 * Postgres runs transactions side by side: two turn appenders read the same
 * tail and insert the same index, and a start-time re-plan can count zero
 * answers while an answer is being committed. Locking the session row makes
 * the second writer wait and then read what the first one committed. Every
 * transaction that decides on the transcript takes this lock first.
 */
export async function lockSession(tx: TransactionClient, sessionId: string): Promise<void> {
  if (!/^postgres(ql)?:/.test(process.env.DATABASE_URL ?? '')) return;
  await tx.$queryRaw`SELECT "id" FROM "InterviewSession" WHERE "id" = ${sessionId} FOR UPDATE`;
}

/**
 * The same, for one account's one-time secrets.
 *
 * Issuing a reset link or a sign-in code is a read-then-write: count what was
 * sent recently, decide the cooldown, retire what is still live, write the new
 * one. Under Postgres's read-committed default two requests for the same
 * account run that side by side — both read no recent row, both pass the
 * cooldown, both retire nothing, and both write. The account ends up with two
 * live links (or two live codes) when the whole design says only the newest
 * one works, and the cooldown that is supposed to bound how much mail one
 * address can be sent does not hold.
 *
 * Each token is still single-use, so this is not a way to spend one twice. It
 * is the account-level invariant that breaks, which matters most in the case
 * the invariant exists for: someone asks for a second link because they think
 * the first was intercepted, and the first quietly keeps working.
 *
 * SQLite serialises writers, so it is already safe there and this is a no-op.
 */
export async function lockUser(tx: TransactionClient, userId: string): Promise<void> {
  if (!/^postgres(ql)?:/.test(process.env.DATABASE_URL ?? '')) return;
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
}
