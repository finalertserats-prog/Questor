import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { _resetSimTenant } from '../sim/session.js';
import {
  SESSION_A, SESSION_A_COME_BACK, SESSION_A_STOP, SESSION_B, SESSION_B_CLOSING_QUESTION,
  auditScriptedTranscript, createScriptedSession, renderScripted, runScript,
} from '../sim/scriptedSessions.js';
import { MOVE_ON_LEAD, PAUSE_REPLY, POSTPONE_REPLY } from '../src/engines/conversationModel.js';

// The two production interviews behind this work, replayed turn by turn
// through the real engine and database on the built-in (no model) path.
// PRINT_TRANSCRIPTS=1 prints them.

const show = (label: string, text: string) => { if (process.env.PRINT_TRANSCRIPTS) console.log(`\n=== ${label} ===\n${text}\n`); };

beforeAll(async () => {
  await wipe();
  _resetSimTenant();
});

describe('Session A — the candidate who wanted to do it later', () => {
  it('ends with a postponement on "can we have this interview later", unscored and awaiting a new time', async () => {
    const sessionId = await createScriptedSession({});
    const run = await runScript(sessionId, SESSION_A);
    show('Session A', renderScripted(run.lines));

    expect(run.lines.filter((l) => l.speaker === 'candidate').map((l) => l.text)).toEqual([SESSION_A[0]]);
    expect(run.last.kind).toBe('postponed');
    expect(run.last.text).toBe(POSTPONE_REPLY);
    expect(run.last.withdrawn).toBe(true);
    expect(run.state).toBe('RESCHEDULE_REQUIRED');
    expect(await prisma.assessmentVersion.count({ where: { sessionId } })).toBe(0);
    const audit = await prisma.auditEvent.findFirst({ where: { entityId: sessionId, action: 'interview.candidate_postponed' } });
    expect(audit?.afterJson).toMatch(/Candidate asked to do this later/);
  });

  it('ends on a typed "Stop" on that very turn, with no work sample', async () => {
    const sessionId = await createScriptedSession({});
    const run = await runScript(sessionId, SESSION_A_STOP);
    show('Session A (Stop)', renderScripted(run.lines));

    expect(run.last.kind).toBe('withdrawn');
    expect(run.lines.at(-2)?.text).toBe('Stop');
    expect(run.lines.some((l) => l.kind === 'work_sample')).toBe(false);
    expect(run.state).toBe('CANDIDATE_WITHDREW');
    expect(await prisma.assessmentVersion.count({ where: { sessionId } })).toBe(0);
  });

  it('hears "I can come back after exams" with no model configured at all', async () => {
    const sessionId = await createScriptedSession({});
    const run = await runScript(sessionId, SESSION_A_COME_BACK);
    show('Session A (come back after exams)', renderScripted(run.lines));

    expect(run.last.kind).toBe('postponed');
    expect(run.state).toBe('RESCHEDULE_REQUIRED');
    expect(await prisma.assessmentVersion.count({ where: { sessionId } })).toBe(0);
  });

  it('can be re-invited after a postponement, and starts again with a greeting', async () => {
    const sessionId = await createScriptedSession({});
    await runScript(sessionId, SESSION_A);
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { state: 'INVITED' } });
    const again = await runScript(sessionId, []);
    expect(again.lines[0].kind).toBe('opening');
    expect(again.lines[0].text).toMatch(/^Hi Jayesh\b/);
  });
});

describe('Session B — the Project Manager whose non-answers were followed up', () => {
  it('handles each moment the production interview got wrong', async () => {
    const sessionId = await createScriptedSession({});
    const run = await runScript(sessionId, SESSION_B, { untilClose: true, closingQuestion: SESSION_B_CLOSING_QUESTION });
    show('Session B', renderScripted(run.lines));
    const reply = (said: string, nth = 0) => {
      const at = run.lines.map((l, i) => (l.speaker === 'candidate' && l.text === said ? i : -1)).filter((i) => i >= 0)[nth];
      return run.lines[at + 1];
    };

    // Greeting by the given name, not an initial.
    expect(run.lines[0].text).toMatch(/^Hi Jayesh\b/);
    // "Oh" gets a simpler rephrase, and "No" straight after it moves on.
    expect(reply('Oh').kind).toBe('rephrase');
    expect(reply('No').text.startsWith(MOVE_ON_LEAD)).toBe(true);
    // "Pause" pauses; "ready" comes back to the same question.
    expect(reply('Pause').text).toBe(PAUSE_REPLY);
    expect(reply('ready').kind).toBe('reask');
    // "Nothing" and "Welcome back" are not followed up as answers.
    expect(reply('Nothing').kind).toBe('rephrase');
    expect(reply('Welcome back').text.startsWith(MOVE_ON_LEAD)).toBe(true);
    // The correction is acknowledged.
    expect(reply(SESSION_B[8]).text).toMatch(/^Thanks for clarifying/);
    // The closing question is answered from the role before the goodbye.
    const signoff = run.lines.at(-1);
    expect(signoff?.kind).toBe('signoff');
    expect(signoff?.text).toMatch(/Project Manager/);
    expect(signoff?.text).toMatch(/delivery of online survey projects/i);

    const audit = auditScriptedTranscript(run.lines);
    expect(audit.followedUpNonAnswers).toEqual([]);
    expect(audit.repeatedTopics).toEqual([]);
    expect(audit.askedAfterEnding).toBe(false);
    // Nothing the production interview drifted into, for a role that is not about it.
    for (const l of run.lines.filter((x) => x.speaker === 'interviewer')) {
      expect(l.text).not.toMatch(/build[- ]?(?:versus|vs|or)[- ]?buy|architecture|long-term consequence/i);
    }
  });

  it('scores none of the non-answers as evidence', async () => {
    const sessionId = await createScriptedSession({});
    await runScript(sessionId, SESSION_B, { untilClose: true, closingQuestion: 'No, thank you.' });
    const { finalizeInterview } = await import('../src/realtime/interviewEngine.js');
    const { assessmentId } = await finalizeInterview(sessionId);
    const row = await prisma.assessmentVersion.findUnique({ where: { id: assessmentId } });
    const result = JSON.parse(row?.resultJson ?? '{}') as { competencies?: Array<{ evidence?: Array<{ quote: string }> }> };
    const quotes = (result.competencies ?? []).flatMap((c) => (c.evidence ?? []).map((e) => e.quote));
    expect(quotes.length).toBeGreaterThan(0);
    for (const said of ['Oh', 'No', 'Pause', 'Nothing', 'Welcome back', 'ready']) {
      expect(quotes, said).not.toContain(said);
    }
  });
});
