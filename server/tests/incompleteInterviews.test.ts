import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { sweepIncompleteInterviews, INACTIVITY_MS } from '../src/services/incompleteInterviews.js';

const app = createApp();

/**
 * Interviews that stopped part-way.
 *
 * Two real candidates sat in ASSESSING all evening after closing the tab. They
 * showed as "in progress" on the dashboard, nobody was told to chase them, and
 * their transcripts never became anything a reviewer could open.
 *
 * The first version of this sweep scored any interview with three or more
 * substantial answers. That was wrong, and the tests below are the guard: a
 * candidate whose network dropped must not acquire a permanent recommendation
 * from an interview they never chose to end.
 */

/** Push every turn past the inactivity window. */
async function goQuiet(sessionId: string) {
  const past = new Date(Date.now() - INACTIVITY_MS - 60_000);
  await prisma.turn.updateMany({ where: { sessionId }, data: { createdAt: past } });
}

async function beginInterview() {
  await wipe();
  const ids = await createDemoData();
  await request(app).post(`/api/portal/${ids.token}/accept`).send({});
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${ids.token}/start`).send({});
  return ids;
}

const STRONG_ANSWERS = [
  'I led the payments platform team for four years and owned the ledger service end to end.',
  'The hardest problem was reconciliation drift, which we solved with an idempotent replay pipeline.',
  'I tracked unmatched transactions, which fell from about two thousand a day to under thirty.',
  'Looking back I would have introduced the replay mechanism far earlier than we did.',
];

describe('interviews that stopped part-way', () => {
  it('never scores an interrupted interview, however much was said', async () => {
    // THE point of this file. Four strong answers then the network drops is not
    // a performance to be judged — the candidate did not choose to end it, and
    // no timer should decide a partial transcript is enough to rate a person on.
    const ids = await beginInterview();
    for (const text of STRONG_ANSWERS) {
      await request(app).post(`/api/portal/${ids.token}/turn`).send({ text });
    }
    await goQuiet(ids.sessionId);

    await sweepIncompleteInterviews();

    expect(await prisma.assessmentVersion.count({ where: { sessionId: ids.sessionId } })).toBe(0);
    const session = await prisma.interviewSession.findUnique({ where: { id: ids.sessionId } });
    expect(session?.state).toBe('INCOMPLETE');
  });

  it('saves a transcript a reviewer can open', async () => {
    const ids = await beginInterview();
    for (const text of STRONG_ANSWERS) {
      await request(app).post(`/api/portal/${ids.token}/turn`).send({ text });
    }
    await goQuiet(ids.sessionId);

    await sweepIncompleteInterviews();

    const transcript = await prisma.artifact.findFirst({
      where: { sessionId: ids.sessionId, kind: 'transcript' },
    });
    expect(transcript).not.toBeNull();
    expect(transcript!.storageKey).toContain('reconciliation drift');
  });

  it('does not record it as completed', async () => {
    // A report counting completed interviews must not count an interrupted one.
    const ids = await beginInterview();
    await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: STRONG_ANSWERS[0] });
    await goQuiet(ids.sessionId);

    await sweepIncompleteInterviews();

    const session = await prisma.interviewSession.findUnique({ where: { id: ids.sessionId } });
    expect(session?.completedAt).toBeNull();
    expect(session?.interruptedAt).not.toBeNull();
  });

  it('leaves the invitation usable so the candidate can come back', async () => {
    // A 25-minute outage must not cost someone their interview. Burning the
    // link would make our unreliability their problem.
    const ids = await beginInterview();
    await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: STRONG_ANSWERS[0] });
    await goQuiet(ids.sessionId);

    await sweepIncompleteInterviews();

    const invitation = await prisma.invitation.findFirst({ where: { sessionId: ids.sessionId } });
    expect(invitation?.status).not.toBe('consumed');
  });

  it('leaves an interview alone while the candidate is still answering', async () => {
    const ids = await beginInterview();
    await request(app).post(`/api/portal/${ids.token}/turn`)
      .send({ text: 'I own the reconciliation pipeline and the warehouse models behind it.' });

    const outcomes = await sweepIncompleteInterviews();

    expect(outcomes).toHaveLength(0);
    const session = await prisma.interviewSession.findUnique({ where: { id: ids.sessionId } });
    expect(session?.state).not.toBe('INCOMPLETE');
  });

  it('ignores an invitation nobody has spoken into', async () => {
    await wipe();
    const ids = await createDemoData();

    const outcomes = await sweepIncompleteInterviews();

    expect(outcomes).toHaveLength(0);
    const session = await prisma.interviewSession.findUnique({ where: { id: ids.sessionId } });
    expect(session?.state).not.toBe('INCOMPLETE');
  });

  it('is safe to run twice', async () => {
    const ids = await beginInterview();
    await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: STRONG_ANSWERS[0] });
    await goQuiet(ids.sessionId);

    await sweepIncompleteInterviews();
    const second = await sweepIncompleteInterviews();

    expect(second).toHaveLength(0);
    expect(await prisma.artifact.count({ where: { sessionId: ids.sessionId, kind: 'transcript' } })).toBe(1);
  });

  it('makes no provider calls, so a backlog cannot produce a surprise bill', async () => {
    // The sweep runs on a timer over an unbounded set of sessions. If it ran the
    // evaluator, a backlog would fan out into concurrent paid calls with no cap.
    const ids = await beginInterview();
    for (const text of STRONG_ANSWERS) {
      await request(app).post(`/api/portal/${ids.token}/turn`).send({ text });
    }
    await goQuiet(ids.sessionId);

    const before = await prisma.modelExecution.count();
    await sweepIncompleteInterviews();
    const after = await prisma.modelExecution.count();

    expect(after).toBe(before);
  });
});

describe('a candidate who never got a word in', () => {
  it('is closed out too, rather than stranded for ever', async () => {
    // A real candidate reached the disclosure and stopped, because the "Done
    // answering" button did nothing. An earlier version of this sweep skipped
    // sessions with no candidate turns, which left exactly the person our own
    // bug had harmed sitting in ASSESSING with no transcript.
    await wipe();
    const ids = await createDemoData();
    await request(app).post(`/api/portal/${ids.token}/accept`).send({});
    await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    // No answer ever arrives; the session simply goes quiet.
    await prisma.interviewSession.update({
      where: { id: ids.sessionId },
      data: { startedAt: new Date(Date.now() - INACTIVITY_MS - 60_000) },
    });
    await prisma.turn.updateMany({
      where: { sessionId: ids.sessionId },
      data: { createdAt: new Date(Date.now() - INACTIVITY_MS - 60_000) },
    });

    const outcomes = await sweepIncompleteInterviews();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].candidateAnswers).toBe(0);
    const session = await prisma.interviewSession.findUnique({ where: { id: ids.sessionId } });
    expect(session?.state).toBe('INCOMPLETE');
    // Still not scored — least of all someone who never answered.
    expect(await prisma.assessmentVersion.count({ where: { sessionId: ids.sessionId } })).toBe(0);
  });
});
