import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { submitCandidateTurn } from '../src/realtime/interviewEngine.js';

/**
 * Turn indexes are the transcript's canonical order.
 *
 * Both writers read the turn count and inserted at that number, so two requests
 * arriving together — the socket and the HTTP fallback, or one candidate on two
 * devices — wrote the same index twice. The transcript a reviewer reads, and
 * the evidence quotes anchored to it, then depend on row insertion order rather
 * than on what was said when.
 */

const app = createApp();

async function liveInterview() {
  await wipe();
  const ids = await createDemoData();
  await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${ids.token}/start`).send({});
  return ids;
}

const ANSWERS = [
  'I owned the ledger pipeline and made recovery idempotent after a reconciliation incident.',
  'I designed the finance star schema and cut the month-end close from ninety seconds to eight.',
];

async function answerTwiceAtOnce(sessionId: string) {
  await Promise.all(ANSWERS.map((text) => submitCandidateTurn(sessionId, text)));
  return prisma.turn.findMany({ where: { sessionId }, orderBy: { index: 'asc' }, select: { index: true } });
}

describe('two answers submitted at the same moment', () => {
  it('gives every turn its own index', async () => {
    const ids = await liveInterview();

    const turns = await answerTwiceAtOnce(ids.sessionId);

    expect(new Set(turns.map((t) => t.index)).size).toBe(turns.length);
  });

  it('numbers them consecutively from zero', async () => {
    const ids = await liveInterview();

    const turns = await answerTwiceAtOnce(ids.sessionId);

    expect(turns.map((t) => t.index)).toEqual(turns.map((_, i) => i));
  });

  it('loses neither answer', async () => {
    const ids = await liveInterview();

    await answerTwiceAtOnce(ids.sessionId);

    // Both sets of words survive. They may sit in ONE turn rather than two:
    // two answers against one question with no agent turn between them is the
    // shape the grader misreads, so a second answer to an already-answered
    // question is folded into it (S4, tests/twoTabsOneQuestion.test.ts).
    const said = (await prisma.turn.findMany({ where: { sessionId: ids.sessionId, speaker: 'candidate' }, select: { text: true } }))
      .map((t) => t.text).join(' ');
    expect(ANSWERS.every((answer) => said.includes(answer))).toBe(true);
  });

  it('leaves the transcript alternating, whichever way the race falls', async () => {
    const ids = await liveInterview();

    await answerTwiceAtOnce(ids.sessionId);

    const turns = await prisma.turn.findMany({ where: { sessionId: ids.sessionId }, orderBy: { index: 'asc' }, select: { speaker: true } });
    expect(turns.some((t, i) => i > 0 && t.speaker === 'candidate' && turns[i - 1].speaker === 'candidate')).toBe(false);
  });
});

describe('the database itself', () => {
  it('refuses a duplicate index outright, whatever the application does', async () => {
    const ids = await liveInterview();
    const existing = await prisma.turn.findFirstOrThrow({ where: { sessionId: ids.sessionId } });

    const duplicate = prisma.turn.create({
      data: { sessionId: ids.sessionId, index: existing.index, speaker: 'agent', text: 'A second turn at the same position.' },
    });

    await expect(duplicate).rejects.toThrow();
  });
});
