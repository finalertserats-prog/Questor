import { prisma } from '../db.js';
import { logAudit } from './audit.js';
import {
  checkReadReport, readRefusalMessage, TRANSCRIPT_NOT_READ, TRANSCRIPT_NOT_READ_MESSAGE,
  type ReadReport,
} from '../domain/transcriptRead.js';
import { HttpError } from '../middleware/index.js';

/**
 * The server side of "the transcript was read".
 *
 * The page tracked read progress and said so in a note. This is what turns the
 * note into a rule: the reviewer records that they read the conversation, the
 * server checks the record against the turns that exist, and the verdict
 * endpoint refuses without it.
 *
 * The record is per reviewer, not per assessment: two people reviewing the same
 * interview each read it, and one reader does not discharge the other's duty.
 */

export const TRANSCRIPT_READ_ACTION = 'review.transcript_read';

export interface StoredRead {
  readonly id: string;
  readonly method: string;
  readonly turnsSeen: number;
  readonly turnsTotal: number;
  readonly createdAt: Date;
}

/** The turn indexes this session actually has, in order. */
async function turnIndexesOf(sessionId: string): Promise<number[]> {
  const turns = await prisma.turn.findMany({ where: { sessionId }, orderBy: { index: 'asc' }, select: { index: true } });
  return turns.map((t) => t.index);
}

/**
 * Record that this reviewer read this assessment's transcript.
 *
 * Throws 400 when the report does not cover the conversation, naming how much
 * is left — a reviewer who is told only "no" goes looking for a bug.
 */
export async function recordTranscriptRead(o: {
  readonly tenantId: string;
  readonly reviewerId: string;
  readonly assessmentId: string;
  readonly sessionId: string;
  readonly report: ReadReport;
}): Promise<StoredRead> {
  const allIndexes = await turnIndexesOf(o.sessionId);
  const verdict = checkReadReport(o.report, allIndexes);
  if (!verdict.ok) throw new HttpError(400, readRefusalMessage(verdict));

  const turnsSeen = o.report.method === 'in_app' ? allIndexes.length : 0;
  const data = {
    method: o.report.method,
    turnsSeen,
    turnsTotal: allIndexes.length,
    attestation: o.report.method === 'elsewhere' ? o.report.attestation.trim() : '',
  };
  // A reviewer who reads it again — or double-clicks — has still read it once.
  // The unique key is what decides that, rather than a read both attempts pass.
  const stored = await prisma.transcriptRead.upsert({
    where: { assessmentId_reviewerId: { assessmentId: o.assessmentId, reviewerId: o.reviewerId } },
    create: { tenantId: o.tenantId, assessmentId: o.assessmentId, reviewerId: o.reviewerId, ...data },
    update: data,
    select: { id: true, method: true, turnsSeen: true, turnsTotal: true, createdAt: true },
  });

  await logAudit({
    tenantId: o.tenantId, actorType: 'user', actorId: o.reviewerId, action: TRANSCRIPT_READ_ACTION,
    entityType: 'AssessmentVersion', entityId: o.assessmentId,
    // The attestation itself is kept on the row, which erasure removes; the
    // trail records that one was given and how long it was, which it does not.
    after: {
      method: data.method, turnsSeen: data.turnsSeen, turnsTotal: data.turnsTotal,
      sessionId: o.sessionId, attestationChars: data.attestation.length,
    },
  });
  return stored;
}

/** This reviewer's record for this assessment, or null. */
export async function transcriptReadBy(assessmentId: string, reviewerId: string): Promise<StoredRead | null> {
  return prisma.transcriptRead.findUnique({
    where: { assessmentId_reviewerId: { assessmentId, reviewerId } },
    select: { id: true, method: true, turnsSeen: true, turnsTotal: true, createdAt: true },
  });
}

/**
 * Refuse a verdict from a reviewer who has not read the transcript.
 *
 * Held on the server rather than the page because a gate in the browser is
 * advice. The refusal carries a code the page keys on, so it can put the
 * transcript in front of the reviewer instead of showing them an error.
 */
export async function assertTranscriptRead(assessmentId: string, reviewerId: string): Promise<StoredRead> {
  const read = await transcriptReadBy(assessmentId, reviewerId);
  if (!read) throw new HttpError(409, TRANSCRIPT_NOT_READ_MESSAGE, TRANSCRIPT_NOT_READ);
  return read;
}
