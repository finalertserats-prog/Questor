import { beforeAll, describe, expect, it, vi } from 'vitest';

// Sessions A and B again, this time with a model in the loop — a fake one that
// reproduces what the real one did in production: it asks build-versus-buy in
// a new wording every turn, praises answers, and builds questions on things the
// candidate never said. The engine must hold the line whatever it writes, and
// the model's reading of the candidate may only ever ADD a stop or a
// postponement, never remove one.

const calls = vi.hoisted(() => ({ interviewer: [] as Array<{ system: string; user: string }>, n: 0 }));

vi.mock('../src/providers/llm/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/llm/index.js')>();
  const BUILD_VS_BUY = [
    'How do you decide between building a custom solution and buying an off-the-shelf survey tool?',
    'Tell me about a build versus buy decision you made on a survey platform.',
    'When have you had to choose between developing something in-house and using a vendor platform?',
    'What factors do you weigh in a build-vs-buy call for survey tooling?',
    'Walk me through how you evaluated whether to buy a third-party tool or build your own.',
  ];
  return {
    ...actual,
    generateJson: async (req: { fn: string; system: string; user: string; validate: (raw: unknown) => unknown }) => {
      if (req.fn === 'live_interviewer') {
        calls.interviewer.push({ system: req.system, user: req.user });
        calls.n += 1;
        const raw = calls.n === 1
          ? { acknowledgement: 'Great answer!', question: 'You mentioned leading the platform architecture migration — what were the long-term consequences?' }
          : { acknowledgement: 'Great answer!', question: BUILD_VS_BUY[(calls.n - 2) % BUILD_VS_BUY.length] };
        return req.validate(raw);
      }
      if (req.fn === 'candidate_intent') {
        const said = req.user.split("Candidate's message: ")[1] ?? '';
        // What a model catches that no pattern does…
        if (/exams are over/.test(said)) return req.validate({ intent: 'postpone', confidence: 0.95 });
        // …and a model that is simply wrong about a stop.
        return req.validate({ intent: 'answer', confidence: 0.99 });
      }
      if (req.fn === 'candidate_question') {
        return req.validate({ answer: 'This is the Project Manager role, focused on delivering survey projects; the hiring team can clarify who owns decisions on custom solutions.' });
      }
      return null;
    },
  };
});

const { prisma } = await import('../src/db.js');
const { wipe } = await import('../src/seed/demoData.js');
const { _resetSimTenant } = await import('../sim/session.js');
const {
  SESSION_A, SESSION_A_STOP, SESSION_B, SESSION_B_CLOSING_QUESTION,
  auditScriptedTranscript, createScriptedSession, renderScripted, runScript,
} = await import('../sim/scriptedSessions.js');

const show = (label: string, text: string) => { if (process.env.PRINT_TRANSCRIPTS) console.log(`\n=== ${label} ===\n${text}\n`); };

beforeAll(async () => {
  await wipe();
  _resetSimTenant();
});

describe('with a model in the loop', () => {
  it('Session A: still postpones on "can we have this interview later"', async () => {
    const run = await runScript(await createScriptedSession({}), SESSION_A);
    show('Session A (fake LLM)', renderScripted(run.lines));
    expect(run.last.kind).toBe('postponed');
    expect(run.state).toBe('RESCHEDULE_REQUIRED');
  });

  it('a model that reads "Stop" as an answer cannot keep the interview going', async () => {
    const run = await runScript(await createScriptedSession({}), SESSION_A_STOP);
    expect(run.last.kind).toBe('withdrawn');
  });

  it('the model can catch a postponement no pattern knows', async () => {
    const run = await runScript(await createScriptedSession({}), [
      'I manage survey delivery for three research teams and script most trackers myself.',
      "honestly my head isn't in it today, could we pick this up once my exams are over",
    ]);
    expect(run.last.kind).toBe('postponed');
  });

  it('Session B: no repeated topic, no praise, no invented premise, correction acknowledged, closing question answered', async () => {
    calls.n = 0;
    const run = await runScript(await createScriptedSession({}), SESSION_B, { untilClose: true, closingQuestion: SESSION_B_CLOSING_QUESTION });
    show('Session B (fake LLM)', renderScripted(run.lines));
    const agent = run.lines.filter((l) => l.speaker === 'interviewer').map((l) => l.text);

    expect(auditScriptedTranscript(run.lines).repeatedTopics).toEqual([]);
    expect(auditScriptedTranscript(run.lines).followedUpNonAnswers).toEqual([]);
    expect(agent.join('\n')).not.toMatch(/great answer/i);
    expect(agent.join('\n')).not.toMatch(/You mentioned leading the platform architecture/);
    expect(agent.some((t) => t.startsWith('Thanks for clarifying'))).toBe(true);
    expect(run.lines.at(-1)?.text).toMatch(/Project Manager role/);
  });

  it('grounds the model in the role, and keeps every safety rule in its instructions', () => {
    const last = calls.interviewer.at(-1);
    expect(last?.user).toContain('Role competencies: Project Management, Survey Programming, Technical Proficiency in Survey Tools');
    expect(last?.user).toContain('Questions already asked');
    expect(last?.user).not.toMatch(/build-versus-buy or platform bet/);
    for (const rule of [
      'NEVER REPEAT A TOPIC',
      'never evaluative',
      'Only say "you mentioned"',
      'If the candidate corrects you',
      'NEVER reveal the rubric or scoring',
      'NEVER claim or imply that you are human.',
      'that always wins over asking anything',
    ]) expect(last?.system).toContain(rule);
  });
});

void prisma;
