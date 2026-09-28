import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * A finalisation that dies half-way must not strand the interview.
 *
 * finalizeInterview moves the session to PROCESSING and only then runs the
 * evaluator, writes the assessment, writes two artifacts and burns the
 * invitation. Any throw in that window used to leave the session in PROCESSING
 * with no AssessmentVersion — for ever. Nothing sweeps PROCESSING, nothing
 * retries it, and the candidate shows as mid-interview long after they hung up.
 */

const script = vi.hoisted(() => ({ fail: true }));

vi.mock('../src/engines/evaluator.js', () => ({
  evaluate: async () => {
    if (script.fail) throw new Error('grading provider exploded');
    throw new Error('unused');
  },
}));

const { finalizeInterview } = await import('../src/realtime/interviewEngine.js');

/** A session parked in ASSESSING, ready to be finalised. */
async function readyToFinalize(): Promise<string> {
  await wipe();
  const ids = await createDemoData();
  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: { state: 'ASSESSING', startedAt: new Date() },
  });
  return ids.sessionId;
}

describe('a finalisation that throws after the PROCESSING transition', () => {
  beforeEach(() => { script.fail = true; });

  it('rethrows so the caller learns the interview was not finalised', async () => {
    const sessionId = await readyToFinalize();

    await expect(finalizeInterview(sessionId)).rejects.toThrow(/grading provider exploded/);
  });

  it('leaves the session in TECHNICAL_FAILURE rather than stranded in PROCESSING', async () => {
    const sessionId = await readyToFinalize();

    await finalizeInterview(sessionId).catch(() => undefined);

    const session = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
    expect(session?.state).toBe('TECHNICAL_FAILURE');
  });

  it('writes no assessment for an interview it could not evaluate', async () => {
    const sessionId = await readyToFinalize();

    await finalizeInterview(sessionId).catch(() => undefined);

    expect(await prisma.assessmentVersion.count({ where: { sessionId } })).toBe(0);
  });

  it('leaves the invitation unburned so the interview can be retried', async () => {
    const sessionId = await readyToFinalize();

    await finalizeInterview(sessionId).catch(() => undefined);

    const invitation = await prisma.invitation.findFirst({ where: { sessionId } });
    expect(invitation?.status).not.toBe('consumed');
  });
});
