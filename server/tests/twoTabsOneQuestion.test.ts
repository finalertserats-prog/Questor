import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { submitCandidateAnswer } from '../src/realtime/interviewEngine.js';

/**
 * S4 / R16: two tabs answering the same question at the same moment put two
 * consecutive candidate turns on the transcript with no agent turn between
 * them (indexes 3 and 4).
 *
 * `inReplyTo` did not catch it. Both tabs were looking at the same agent turn,
 * and that agent turn is STILL the newest one after the first answer lands, so
 * the staleness check passed for both. The grader attributes quotes to
 * competencies by question slot (engines/evaluator.ts), so the second answer
 * was credited to whichever competency that slot happened to carry.
 *
 * The window is narrow — between the first tab's answer landing and its reply
 * being written — and SQLite serialises writers, so two `Promise.all` calls
 * here usually miss it while Postgres hits it. Both are covered:
 *
 *   "the interleaving itself" puts the transcript in exactly the state the
 *   race produces (an answer sitting after the newest agent turn) and drives
 *   the second tab into it. Deterministic on any backend.
 *
 *   "tabs racing" runs them concurrently and asserts the invariant however the
 *   race falls, because a race that passes once has not been shown to be safe.
 */

const app = createApp();
const ROUNDS = 6;

async function liveInterview() {
  await wipe();
  const ids = await createDemoData();
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${ids.token}/start`).send({});
  return ids;
}

const transcript = (sessionId: string) => prisma.turn.findMany({
  where: { sessionId }, orderBy: { index: 'asc' },
  select: { index: true, speaker: true, text: true, metaJson: true },
});

/** The agent turn the candidate is looking at: what a tab sends as inReplyTo. */
async function currentQuestion(sessionId: string): Promise<{ id: string; index: number }> {
  return prisma.turn.findFirstOrThrow({
    where: { sessionId, speaker: 'agent' }, orderBy: { index: 'desc' }, select: { id: true, index: true },
  });
}

/**
 * The first tab's answer on record, with no reply to it yet — the half-second
 * the second tab's request lands in.
 */
async function answerLanded(sessionId: string, text: string): Promise<void> {
  const tail = await prisma.turn.findFirstOrThrow({ where: { sessionId }, orderBy: { index: 'desc' }, select: { index: true, endMs: true } });
  await prisma.turn.create({
    data: {
      id: nanoid(10), sessionId, index: tail.index + 1, speaker: 'candidate', text,
      startMs: tail.endMs + 1000, endMs: tail.endMs + 30_000, confidence: 0.9, competencyId: '',
    },
  });
}

/** True when any candidate turn sits immediately after another candidate turn. */
function hasConsecutiveAnswers(turns: readonly { speaker: string }[]): boolean {
  return turns.some((t, i) => i > 0 && t.speaker === 'candidate' && turns[i - 1].speaker === 'candidate');
}

const TAB_A = 'I owned the ledger pipeline and made recovery idempotent after a reconciliation incident.';
const TAB_B = 'I designed the finance star schema and cut the month-end close from ninety seconds to eight.';

describe('the interleaving itself', () => {
  it('never leaves two candidate turns in a row', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const ids = await liveInterview();
      const question = await currentQuestion(ids.sessionId);
      await answerLanded(ids.sessionId, TAB_A);

      await submitCandidateAnswer(ids.sessionId, TAB_B, undefined, { inReplyTo: question.id });

      expect([round, hasConsecutiveAnswers(await transcript(ids.sessionId))]).toEqual([round, false]);
    }
  }, 180_000);

  it('leaves exactly one answer against the question that was asked', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const ids = await liveInterview();
      const question = await currentQuestion(ids.sessionId);
      await answerLanded(ids.sessionId, TAB_A);

      await submitCandidateAnswer(ids.sessionId, TAB_B, undefined, { inReplyTo: question.id });

      const answers = (await transcript(ids.sessionId)).filter((t) => t.speaker === 'candidate' && t.index > question.index);
      expect([round, answers.length]).toEqual([round, 1]);
    }
  }, 180_000);

  it('loses neither tab words', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const ids = await liveInterview();
      const question = await currentQuestion(ids.sessionId);
      await answerLanded(ids.sessionId, TAB_A);

      await submitCandidateAnswer(ids.sessionId, TAB_B, undefined, { inReplyTo: question.id });

      const said = (await transcript(ids.sessionId)).filter((t) => t.speaker === 'candidate').map((t) => t.text).join(' ');
      expect([round, said.includes(TAB_A), said.includes(TAB_B)]).toEqual([round, true, true]);
    }
  }, 180_000);

  it('says on the turn that one question was answered twice', async () => {
    const ids = await liveInterview();
    const question = await currentQuestion(ids.sessionId);
    await answerLanded(ids.sessionId, TAB_A);

    await submitCandidateAnswer(ids.sessionId, TAB_B, undefined, { inReplyTo: question.id });

    const answer = (await transcript(ids.sessionId)).find((t) => t.speaker === 'candidate' && t.index > question.index)!;
    expect(JSON.parse(answer.metaJson || '{}').submissions).toBe(2);
  }, 60_000);

  it('is idempotent when the same submission is retried', async () => {
    const ids = await liveInterview();
    const question = await currentQuestion(ids.sessionId);
    await answerLanded(ids.sessionId, TAB_A);

    await submitCandidateAnswer(ids.sessionId, TAB_A, undefined, { inReplyTo: question.id });

    const answer = (await transcript(ids.sessionId)).find((t) => t.speaker === 'candidate' && t.index > question.index)!;
    expect(answer.text.split(TAB_A).length - 1).toBe(1);
  }, 60_000);

  it('holds without inReplyTo too, so the socket path cannot interleave either', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const ids = await liveInterview();
      await answerLanded(ids.sessionId, TAB_A);

      await submitCandidateAnswer(ids.sessionId, TAB_B);

      expect([round, hasConsecutiveAnswers(await transcript(ids.sessionId))]).toEqual([round, false]);
    }
  }, 180_000);

  it('still records a Leave after an answer: an action, not a second answer', async () => {
    const ids = await liveInterview();
    const question = await currentQuestion(ids.sessionId);
    await answerLanded(ids.sessionId, TAB_A);

    await submitCandidateAnswer(ids.sessionId, '', undefined, { inReplyTo: question.id, leaving: true });

    const answers = (await transcript(ids.sessionId)).filter((t) => t.speaker === 'candidate' && t.index > question.index);
    expect([answers.length, answers[0].text]).toEqual([2, TAB_A]);
  }, 60_000);
});

describe('tabs racing', () => {
  it('never leaves two candidate turns in a row, however the race falls', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const ids = await liveInterview();
      const question = await currentQuestion(ids.sessionId);

      // One of the two may be refused as stale; that is a correct outcome too.
      // What must never happen is the transcript ending up misshapen.
      await Promise.allSettled([
        submitCandidateAnswer(ids.sessionId, TAB_A, undefined, { inReplyTo: question.id }),
        submitCandidateAnswer(ids.sessionId, TAB_B, undefined, { inReplyTo: question.id }),
      ]);

      expect([round, hasConsecutiveAnswers(await transcript(ids.sessionId))]).toEqual([round, false]);
    }
  }, 180_000);

  it('answers one question once, five tabs or not', async () => {
    for (let round = 0; round < 3; round++) {
      const ids = await liveInterview();
      const question = await currentQuestion(ids.sessionId);

      await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => submitCandidateAnswer(ids.sessionId, `${TAB_A} Attempt ${i}.`, undefined, { inReplyTo: question.id })),
      );

      const answers = (await transcript(ids.sessionId)).filter((t) => t.speaker === 'candidate' && t.index === question.index + 1);
      expect([round, answers.length, hasConsecutiveAnswers(await transcript(ids.sessionId))]).toEqual([round, 1, false]);
    }
  }, 180_000);
});
