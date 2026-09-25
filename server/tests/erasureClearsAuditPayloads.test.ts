import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { eraseCandidate } from '../src/services/dataRights.js';
import { logAudit } from '../src/services/audit.js';
import { PAYLOAD_REMOVED } from '../src/services/auditPayloads.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';

/**
 * Erasure has to remove the person from the audit log too.
 *
 * The trail survives erasure deliberately — a deletion you cannot show you
 * performed is not compliance — and the rule beside it justified that by
 * saying the trail holds no personal data. It does. `accommodation.requested`
 * writes the candidate's own prose about themselves into `afterJson`, which
 * the code two lines below it refuses to put in an email BECAUSE it can
 * describe a health condition; `identity.code_send_failed` writes an SMTP
 * rejection, and those quote the address they refused.
 *
 * So a candidate who exercised the strongest right the product offers was
 * told they were gone while their health disclosure stayed.
 *
 * The audit rows here are written through `logAudit`, the same function the
 * product writes them with, in the shape the product writes them — not hand-
 * built fixtures. A test that constructs its own input only ever proves the
 * reader matches what its author imagined, which is how three other defects
 * in this codebase survived a green suite.
 */

const ACCOMMODATION = 'I have dyslexia and need extra time to read the questions.';
const SMTP_REJECTION = '550 5.1.1 <priya.sharma@example.com>: Recipient address rejected';

interface World {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly sessionId: string;
  readonly pipelineId: string;
}

let world: World;

/**
 * The product's own seed rather than hand-built rows: it creates the tenant,
 * role, candidate and session in the shapes the application actually writes,
 * so this test cannot drift from the schema the way a private fixture does.
 */
async function seedWorld(): Promise<World> {
  await wipe();
  const ids = await createDemoData();
  const pipeline = await prisma.candidatePipeline.create({
    data: {
      tenantId: ids.tenantId, candidateId: ids.candidateId, roleId: ids.roleId,
      stagesJson: '[]', currentStageKey: 'intake', status: 'ACTIVE',
    },
  });
  return { tenantId: ids.tenantId, candidateId: ids.candidateId, sessionId: ids.sessionId, pipelineId: pipeline.id };
}

beforeAll(async () => {
  world = await seedWorld();

  // Exactly as routes/portal.ts writes it when a candidate asks for an adjustment.
  await logAudit({
    tenantId: world.tenantId, actorType: 'user', actorId: 'candidate',
    action: 'accommodation.requested', entityType: 'InterviewSession', entityId: world.sessionId,
    after: { request: ACCOMMODATION },
  });
  // Exactly as services/identityCode.ts writes it when the mail provider refuses.
  await logAudit({
    tenantId: world.tenantId, actorType: 'system', actorId: 'system',
    action: 'identity.code_send_failed', entityType: 'InterviewSession', entityId: world.sessionId,
    after: { detail: SMTP_REJECTION },
  });
  // A staff reason about the candidate, on a different entity of theirs.
  await logAudit({
    tenantId: world.tenantId, actorType: 'user', actorId: 'u1',
    action: 'pipeline.decided', entityType: 'CandidatePipeline', entityId: world.pipelineId,
    before: { note: 'Priya asked to be considered for the London team instead.' },
    after: { outcome: 'rejected' },
  });
});

async function payloadsFor(entityId: string): Promise<string[]> {
  const rows = await prisma.auditEvent.findMany({ where: { entityId }, select: { beforeJson: true, afterJson: true } });
  return rows.flatMap((row) => [row.beforeJson, row.afterJson]);
}

describe('erasure and the audit log', () => {
  it('writes the health disclosure into the audit log in the first place', async () => {
    // Self-verifying: if this ever stops being true the assertions below would
    // pass for the wrong reason, and the test would be proving nothing.
    expect((await payloadsFor(world.sessionId)).join(' ')).toContain('dyslexia');
  });

  it('leaves no trace of the candidate in any audit payload once they are erased', async () => {
    await eraseCandidate({
      tenantId: world.tenantId, candidateId: world.candidateId,
      actorId: 'u1', reason: 'The candidate asked to be erased.',
    });

    const everything = await prisma.auditEvent.findMany({ select: { beforeJson: true, afterJson: true } });
    const haystack = everything.map((row) => `${row.beforeJson} ${row.afterJson}`).join('\n').toLowerCase();

    for (const needle of ['dyslexia', 'priya', 'sharma', 'priya.sharma@example.com']) {
      expect(haystack, `"${needle}" survived erasure`).not.toContain(needle);
    }
  });

  it('keeps the rows themselves, because the record IS the compliance evidence', async () => {
    const rows = await prisma.auditEvent.findMany({
      where: { entityId: world.sessionId },
      select: { action: true, actorId: true, entityType: true, createdAt: true },
    });
    expect(rows.map((r) => r.action).sort()).toEqual(['accommodation.requested', 'identity.code_send_failed']);
    for (const row of rows) {
      expect(row.actorId).not.toBe('');
      expect(row.entityType).toBe('InterviewSession');
      expect(row.createdAt).toBeInstanceOf(Date);
    }
  });

  it('marks a cleared payload as cleared rather than as never written', async () => {
    // "" already means "this action recorded no payload". Reusing it would make
    // the log unable to tell a silent action from a redacted one.
    const cleared = await prisma.auditEvent.findFirst({
      where: { entityId: world.sessionId, action: 'accommodation.requested' },
      select: { afterJson: true, beforeJson: true },
    });
    expect(cleared?.afterJson).toBe(PAYLOAD_REMOVED);
    // It never had a `before`, and clearing must not invent one.
    expect(cleared?.beforeJson).toBe('');
  });

  it('records the erasure itself, which is the whole reason the trail survives', async () => {
    const erasure = await prisma.auditEvent.findFirst({ where: { action: { contains: 'erase' } } });
    expect(erasure).not.toBeNull();
  });

  /**
   * The erasure's own audit row is written AFTER the payloads are cleared, so
   * nothing cleans it. Today that is safe because the row records
   * `reasonProvided` as a boolean rather than the operator's sentence — but
   * the operator is typing free text into a field called `reason`, and the
   * day somebody decides the trail would be more useful with the words in it,
   * this is the only thing standing between that decision and a health
   * disclosure surviving the erasure that was supposed to remove it.
   *
   * Raised by an adversarial review as a live blocker. It was wrong about
   * today and right about tomorrow.
   */
  it('never writes the operator\'s own words into the erasure record', async () => {
    const erasure = await prisma.auditEvent.findFirstOrThrow({
      where: { action: { contains: 'erase' } },
      select: { beforeJson: true, afterJson: true },
    });
    const payload = `${erasure.beforeJson} ${erasure.afterJson}`.toLowerCase();
    // The reason passed to eraseCandidate above, and the candidate it was about.
    for (const needle of ['asked to be erased', 'priya', 'sharma', 'dyslexia']) {
      expect(payload, `the erasure record repeated "${needle}"`).not.toContain(needle);
    }
  });
});
