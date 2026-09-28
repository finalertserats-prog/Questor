import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * The races a rejoin opens up, and what the candidate is told about them.
 *
 * A reload while an answer is still being replied to, or a second tab, means
 * the room can be showing a question the server has already moved past. An
 * answer sent against that stale question used to be credited to the newer one
 * the candidate never saw.
 */

const app = createApp();

const ANSWER = 'I lead the data platform team and moved our nightly batch jobs to streaming pipelines.';
const HOUR = 60 * 60 * 1000;

async function consented() {
  await wipe();
  const ids = await createDemoData();
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: false, accepted: true });
  return ids;
}

async function started() {
  const ids = await consented();
  const opening = await request(app).post(`/api/portal/${ids.token}/start`).send({});
  return { ...ids, opening: opening.body };
}

async function answered() {
  const ids = await started();
  const reply = await request(app).post(`/api/portal/${ids.token}/turn`)
    .send({ text: ANSWER, inReplyTo: ids.opening.turn.turnId });
  return { ...ids, reply: reply.body };
}

/** An answer on record with no reply to it: the model failed, or a reload beat it. */
async function answerWithoutReply(opts: { ageMs?: number } = {}) {
  const ids = await started();
  const tail = await prisma.turn.findFirst({ where: { sessionId: ids.sessionId }, orderBy: { index: 'desc' } });
  await prisma.turn.create({
    data: {
      id: 'orphan-answer', sessionId: ids.sessionId, index: (tail?.index ?? 0) + 1, speaker: 'candidate', text: ANSWER,
      startMs: 13_000, endMs: 40_000, confidence: 0.9, competencyId: tail?.competencyId ?? '',
      createdAt: new Date(Date.now() - (opts.ageMs ?? 0)),
    },
  });
  return ids;
}

const turnCount = (sessionId: string) => prisma.turn.count({ where: { sessionId } });

describe('an answer sent against a question the interview has moved past', () => {
  it('is refused as stale', async () => {
    const ids = await answered();

    const res = await request(app).post(`/api/portal/${ids.token}/turn`)
      .send({ text: 'A second answer to the opening.', inReplyTo: ids.opening.turn.turnId });

    expect(res.body.code).toBe('stale_question');
  });

  it('is refused with a conflict status', async () => {
    const ids = await answered();

    const res = await request(app).post(`/api/portal/${ids.token}/turn`)
      .send({ text: 'A second answer to the opening.', inReplyTo: ids.opening.turn.turnId });

    expect(res.status).toBe(409);
  });

  it('is not written to the transcript', async () => {
    const ids = await answered();
    const before = await turnCount(ids.sessionId);

    await request(app).post(`/api/portal/${ids.token}/turn`)
      .send({ text: 'A second answer to the opening.', inReplyTo: ids.opening.turn.turnId });

    expect(await turnCount(ids.sessionId)).toBe(before);
  });

  it('is accepted when it names the current question', async () => {
    const ids = await answered();

    const res = await request(app).post(`/api/portal/${ids.token}/turn`)
      .send({ text: 'We used Kafka and Flink.', inReplyTo: ids.reply.turn.turnId });

    expect(res.status).toBe(200);
  });

  it('is accepted from an older client that names no question', async () => {
    const ids = await answered();

    const res = await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'We used Kafka and Flink.' });

    expect(res.status).toBe(200);
  });
});

describe('what the portal sends the candidate about a turn', () => {
  it('is only what the room uses, from start', async () => {
    const ids = await started();

    expect(Object.keys(ids.opening.turn).sort()).toEqual(['done', 'text', 'turnId', 'withdrawn']);
  });

  it('is only what the room uses, from an answer', async () => {
    const ids = await answered();

    expect(Object.keys(ids.reply.turn).sort()).toEqual(['done', 'text', 'turnId', 'withdrawn']);
  });
});

describe('the clock handed to a rejoining room', () => {
  it('continues from the last stamp on record, not from wall-clock time away', async () => {
    const ids = await answered();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { startedAt: new Date(Date.now() - 2 * HOUR) } });
    const lastEnd = (await prisma.turn.aggregate({ where: { sessionId: ids.sessionId }, _max: { endMs: true } }))._max.endMs ?? 0;

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.elapsedMs).toBeLessThan(lastEnd + 10_000);
  });

  it('is capped, so one absurd stamp cannot push later answers past the limit', async () => {
    const ids = await answered();
    const tail = await prisma.turn.findFirst({ where: { sessionId: ids.sessionId }, orderBy: { index: 'desc' } });
    await prisma.turn.update({ where: { id: tail!.id }, data: { endMs: 23 * HOUR } });

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.elapsedMs).toBeLessThanOrEqual(6 * HOUR);
  });

  it('records the rejoin for reviewers instead', async () => {
    const ids = await answered();

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(await prisma.auditEvent.count({ where: { entityId: ids.sessionId, action: 'interview.rejoined' } })).toBe(1);
  });

  // A room waiting for a reply re-reads start every couple of seconds; that is
  // one rejoin, not twenty entries in the reviewer's audit trail.
  it('records a burst of re-reads as one rejoin', async () => {
    const ids = await answered();

    for (let i = 0; i < 3; i++) await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(await prisma.auditEvent.count({ where: { entityId: ids.sessionId, action: 'interview.rejoined' } })).toBe(1);
  });
});

describe('rejoining right after an answer was sent', () => {
  it('says how long ago that answer arrived, so the room can wait for the reply', async () => {
    const ids = await answerWithoutReply({ ageMs: 5_000 });

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.pendingAnswerAgeMs).toBeGreaterThanOrEqual(5_000);
  });

  it('sends no age when no answer is waiting', async () => {
    const ids = await answered();

    const rejoin = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(rejoin.body.pendingAnswerAgeMs).toBeUndefined();
  });
});

describe('continuing after an answer that never got a reply', () => {
  it('produces the reply', async () => {
    const ids = await answerWithoutReply();

    const res = await request(app).post(`/api/portal/${ids.token}/continue`).send({});

    const tail = await prisma.turn.findFirst({ where: { sessionId: ids.sessionId }, orderBy: { index: 'desc' } });
    expect(res.body.turn.turnId).toBe(tail?.id);
  });

  it('writes exactly one reply', async () => {
    const ids = await answerWithoutReply();

    await request(app).post(`/api/portal/${ids.token}/continue`).send({});

    expect(await turnCount(ids.sessionId)).toBe(3);
  });

  it('is idempotent: pressing it again hands back the same reply', async () => {
    const ids = await answerWithoutReply();
    const first = await request(app).post(`/api/portal/${ids.token}/continue`).send({});

    const second = await request(app).post(`/api/portal/${ids.token}/continue`).send({});

    expect(second.body.turn.turnId).toBe(first.body.turn.turnId);
  });

  it('writes one reply when pressed twice at once', async () => {
    const ids = await answerWithoutReply();

    await Promise.all([
      request(app).post(`/api/portal/${ids.token}/continue`).send({}),
      request(app).post(`/api/portal/${ids.token}/continue`).send({}),
    ]);

    expect(await turnCount(ids.sessionId)).toBe(3);
  });

  it('hands back the pending question when no answer is waiting', async () => {
    const ids = await answered();

    const res = await request(app).post(`/api/portal/${ids.token}/continue`).send({});

    expect(res.body.turn.turnId).toBe(ids.reply.turn.turnId);
  });

  it('writes nothing when no answer is waiting', async () => {
    const ids = await answered();
    const before = await turnCount(ids.sessionId);

    await request(app).post(`/api/portal/${ids.token}/continue`).send({});

    expect(await turnCount(ids.sessionId)).toBe(before);
  });

  it('is refused once the interview is complete', async () => {
    const ids = await answerWithoutReply();
    await prisma.invitation.updateMany({ where: { sessionId: ids.sessionId }, data: { status: 'consumed' } });

    const res = await request(app).post(`/api/portal/${ids.token}/continue`).send({});

    expect(res.status).toBe(410);
  });

  it('is refused before the interview has started', async () => {
    const ids = await consented();

    const res = await request(app).post(`/api/portal/${ids.token}/continue`).send({});

    expect(res.status).toBe(409);
  });

  it('sends only what the room uses', async () => {
    const ids = await answerWithoutReply();

    const res = await request(app).post(`/api/portal/${ids.token}/continue`).send({});

    expect(Object.keys(res.body.turn).sort()).toEqual(['done', 'text', 'turnId', 'withdrawn']);
  });
});

describe('two starts racing from before the interview', () => {
  it('produce one opening between them', async () => {
    const ids = await consented();

    await Promise.all([
      request(app).post(`/api/portal/${ids.token}/start`).send({}),
      request(app).post(`/api/portal/${ids.token}/start`).send({}),
    ]);

    expect(await turnCount(ids.sessionId)).toBe(1);
  });

  it('hand both callers the same opening', async () => {
    const ids = await consented();

    const [a, b] = await Promise.all([
      request(app).post(`/api/portal/${ids.token}/start`).send({}),
      request(app).post(`/api/portal/${ids.token}/start`).send({}),
    ]);

    expect(a.body.turn.turnId).toBe(b.body.turn.turnId);
  });

  it('announce the start once', async () => {
    const ids = await consented();

    await Promise.all([
      request(app).post(`/api/portal/${ids.token}/start`).send({}),
      request(app).post(`/api/portal/${ids.token}/start`).send({}),
    ]);

    expect(await prisma.auditEvent.count({ where: { entityId: ids.sessionId, action: 'interview.started' } })).toBe(1);
  });
});

describe('the portal says whether consent is on record', () => {
  it('reports none before the candidate agrees', async () => {
    await wipe();
    const ids = await createDemoData();
    // The seed stamps consent; a recruiter-created session carries only the disclosure.
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { consentJson: JSON.stringify({ disclosureText: 'This interview is AI-run.' }) } });

    const res = await request(app).get(`/api/portal/${ids.token}`);

    expect(res.body.consented).toBe(false);
  });

  it('reports it once they have', async () => {
    const ids = await consented();

    const res = await request(app).get(`/api/portal/${ids.token}`);

    expect(res.body.consented).toBe(true);
  });
});
