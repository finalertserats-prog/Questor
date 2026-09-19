import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { nextUtterance } from '../src/engines/conversationRuntime.js';

// Delegates to the real runtime; wrapped only so a test can see whether it ran.
vi.mock('../src/engines/conversationRuntime.js', async (orig) => {
  const actual = await orig<typeof import('../src/engines/conversationRuntime.js')>();
  return { ...actual, nextUtterance: vi.fn(actual.nextUtterance) };
});

/**
 * Coming back to an interview that is under way resumes it.
 *
 * A reload, a dropped connection or a return through the invitation link calls
 * start again. That used to hand back the opening turn, so the room read the
 * AI disclosure aloud a second time mid-interview and the candidate was asked
 * a question they had answered twenty minutes earlier. Start on a live session
 * now returns the question the candidate still owes an answer to, with the
 * conversation so far so the room can show it.
 */

const app = createApp();

const ANSWER = 'I lead the data platform team and moved our nightly batch jobs to streaming pipelines.';

async function startedInterview(opts: { recordingConsent: boolean } = { recordingConsent: true }) {
  await wipe();
  const ids = await createDemoData();
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: opts.recordingConsent, accepted: true });
  const opening = await request(app).post(`/api/portal/${ids.token}/start`).send({});
  return { ...ids, opening: opening.body };
}

async function answeredOnce(opts?: { recordingConsent: boolean }) {
  const ids = await startedInterview(opts);
  const reply = await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: ANSWER, startMs: null, endMs: null });
  return { ...ids, reply: reply.body };
}

describe('rejoining an interview after answering a question', () => {
  it('hands back the question still waiting for an answer, not the opening', async () => {
    const ids = await answeredOnce();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.turn.turnId).toBe(ids.reply.turn.turnId);
  });

  it('says the interview was resumed', async () => {
    const ids = await answeredOnce();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.resumed).toBe(true);
  });

  it('returns the conversation so far, in order, as speaker and text only', async () => {
    const ids = await answeredOnce();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.history).toEqual([
      { speaker: 'agent', text: ids.opening.turn.text },
      { speaker: 'candidate', text: ANSWER },
      { speaker: 'agent', text: ids.reply.turn.text },
    ]);
  });

  it('writes nothing new into the transcript', async () => {
    const ids = await answeredOnce();
    const before = await prisma.turn.count({ where: { sessionId: ids.sessionId } });

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(await prisma.turn.count({ where: { sessionId: ids.sessionId } })).toBe(before);
  });

  it('does not ask the language model for anything', async () => {
    const ids = await answeredOnce();
    vi.mocked(nextUtterance).mockClear();

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(nextUtterance).not.toHaveBeenCalled();
  });

  it('does not announce the interview as started again', async () => {
    const ids = await answeredOnce();

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(await prisma.auditEvent.count({ where: { entityId: ids.sessionId, action: 'interview.started' } })).toBe(1);
  });

  it('tells the room how far into the interview it is, so answer times keep counting up', async () => {
    const ids = await answeredOnce();
    const lastEnd = (await prisma.turn.aggregate({ where: { sessionId: ids.sessionId }, _max: { endMs: true } }))._max.endMs ?? 0;

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.elapsedMs).toBeGreaterThanOrEqual(lastEnd);
  });

  it('works the same for a candidate answering by typing', async () => {
    const ids = await answeredOnce({ recordingConsent: false });

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.turn.turnId).toBe(ids.reply.turn.turnId);
  });

  it('lets the candidate answer the resumed question', async () => {
    const ids = await answeredOnce();
    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    const next = await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'We used Kafka and Flink.' });

    expect(next.status).toBe(200);
  });
});

describe('rejoining straight after the opening', () => {
  it('hands back the opening, because it is still the question waiting', async () => {
    const ids = await startedInterview();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.history).toEqual([{ speaker: 'agent', text: ids.opening.turn.text }]);
  });

  it('puts only the question again, not the greeting', async () => {
    const ids = await startedInterview();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.turn.text).toBe("Could you briefly tell me about your current role and the project you've worked on that's most relevant to this position?");
  });

  it('keeps the same turn, so the answer is still credited to the opening', async () => {
    const ids = await startedInterview();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.turn.turnId).toBe(ids.opening.turn.turnId);
  });
});

describe('a fresh start', () => {
  it('is not reported as resumed', async () => {
    const ids = await startedInterview();

    expect(ids.opening.resumed).toBe(false);
  });

  it('returns the opening as the whole conversation so far', async () => {
    const ids = await startedInterview();

    expect(ids.opening.history).toEqual([{ speaker: 'agent', text: ids.opening.turn.text }]);
  });
});

describe('rejoining when the last answer never got a reply', () => {
  // The answer was stored but the reply was not — the model failed, or the
  // candidate reloaded while it was thinking. Start must not invent the reply:
  // see startOrResumeInterview for why.
  async function answerWithoutReply() {
    const ids = await startedInterview();
    const tail = await prisma.turn.findFirst({ where: { sessionId: ids.sessionId }, orderBy: { index: 'desc' } });
    await prisma.turn.create({
      data: {
        id: 'orphan-answer', sessionId: ids.sessionId, index: (tail?.index ?? 0) + 1, speaker: 'candidate', text: ANSWER,
        startMs: 13_000, endMs: 40_000, confidence: 0.9, competencyId: tail?.competencyId ?? '',
      },
    });
    return ids;
  }

  it('says a reply is still owed', async () => {
    const ids = await answerWithoutReply();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.awaitingReply).toBe(true);
  });

  it('hands back the question that answer was for, not a new one', async () => {
    const ids = await answerWithoutReply();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.turn.turnId).toBe(ids.opening.turn.turnId);
  });

  it('writes no reply of its own', async () => {
    const ids = await answerWithoutReply();

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(await prisma.turn.count({ where: { sessionId: ids.sessionId } })).toBe(2);
  });

  it('shows the stored answer as the end of the conversation', async () => {
    const ids = await answerWithoutReply();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.history.at(-1)).toEqual({ speaker: 'candidate', text: ANSWER });
  });
});
