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
