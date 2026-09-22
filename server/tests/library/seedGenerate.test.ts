import { describe, expect, it } from 'vitest';
import type { LlmProvider } from '../../src/providers/llm/types.js';
import type { SeedPool } from '../../src/library/seedExport.js';
import { parseSeedLine } from '../../src/library/seedFormat.js';
import { jsonlFrom, newState, withPools } from '../../scripts/library-seed/checkpoint.js';
import { classifyFailure, DEFAULT_LIMIT_COOLDOWN_MS, laneCommand, parseResetTime, type CliResult, type Lane } from '../../scripts/library-seed/lanes.js';
import { parseQuestions, parseVerdicts, PoolStageError, runPool, type PipelineDeps } from '../../scripts/library-seed/pipeline.js';
import { cliProvider, LaneLimitError } from '../../scripts/library-seed/provider.js';
import { runSeed } from '../../scripts/library-seed/run.js';
import { generatorsFor, LaneScheduler } from '../../scripts/library-seed/scheduler.js';
import { summarize } from '../../scripts/library-seed/summary.js';

/** The laptop side of the seed: limits, rotation, defensive parsing, the pool loop, resume. */

const NOW = new Date(2026, 8, 22, 10, 0, 0);

function cli(overrides: Partial<CliResult> = {}): CliResult {
  return { ok: false, stdout: '', stderr: '', exitCode: 1, ms: 10, timedOut: false, ...overrides };
}

describe('parseResetTime', () => {
  it("reads Codex's clock time", () => {
    expect(parseResetTime("You've hit your usage limit. Upgrade to Pro, or try again at 5:12 PM.", NOW)?.getHours()).toBe(17);
  });

  it("reads Codex's date and time", () => {
    const at = parseResetTime("You've hit your usage limit. Try again at Sep 23rd, 2026 3:45 PM.", NOW);
    expect([at?.getDate(), at?.getHours(), at?.getMinutes()]).toEqual([23, 15, 45]);
  });

  it('rolls a clock time already past over to tomorrow', () => {
    expect(parseResetTime('try again at 9:00 AM.', NOW)?.getDate()).toBe(23);
  });

  it('reads a relative wait', () => {
    expect(parseResetTime('Rate limited. Try again in 3 hours.', NOW)?.getTime()).toBe(NOW.getTime() + 3 * 3_600_000);
  });

  it("reads Claude's epoch form", () => {
    expect(parseResetTime('Claude AI usage limit reached|1790000000', NOW)?.getTime()).toBe(1_790_000_000_000);
  });

  it('returns null when the message gives no time', () => {
    expect(parseResetTime('quota exceeded', NOW)).toBeNull();
  });
});

describe('classifyFailure', () => {
  it('parks a lane for the default cool-down when the limit gives no time', () => {
    const failure = classifyFailure(cli({ stderr: 'RESOURCE_EXHAUSTED: quota' }), NOW);
    expect(failure.kind === 'usage_limit' ? failure.until.getTime() - NOW.getTime() : 0).toBe(DEFAULT_LIMIT_COOLDOWN_MS);
  });

  it('calls a timeout transient', () => {
    expect(classifyFailure(cli({ timedOut: true }), NOW)).toEqual({ kind: 'transient', reason: 'timeout' });
  });
});

describe('laneCommand', () => {
  it('gives cmd.exe fixed tokens only, with nothing it would expand or split', () => {
    const line = (['claude', 'codex'] as const).map((lane) => laneCommand(lane).args.at(-1) ?? '').join(' ');
    expect(/[%&|<>^]/.test(line)).toBe(false);
  });

  it('never puts a path on the command line', () => {
    const line = (['claude', 'codex'] as const).map((lane) => laneCommand(lane).args.join(' ')).join(' ');
    expect(/[\\/]\w/.test(line.replace(/\/[dsc]\b/g, ''))).toBe(false);
  });
});

describe('cliProvider', () => {
  it('turns a usage-limit notice on stdout into a LaneLimitError', async () => {
    const provider = cliProvider('codex', async () => cli({ ok: true, exitCode: 0, stdout: "You've hit your usage limit. Try again at 5:12 PM." }), { timeoutMs: 1000, cwd: '.', now: () => NOW });
    await expect(provider.generate([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(LaneLimitError);
  });

  it('returns the reply of a successful call', async () => {
    const provider = cliProvider('claude', async () => cli({ ok: true, exitCode: 0, stdout: '{"a":1}' }), { timeoutMs: 1000, cwd: '.' });
    expect((await provider.generate([{ role: 'user', content: 'x' }])).text).toBe('{"a":1}');
  });
});

function scheduler(lanes: readonly Lane[] = ['claude', 'codex', 'gemini'], clock = { t: NOW.getTime() }) {
  return new LaneScheduler(lanes, { minGapMs: 0, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
}

describe('LaneScheduler', () => {
  it('rotates the generator across pools', () => {
    const s = scheduler();
    expect([0, 1, 2].map((i) => s.assign(i)?.generator)).toEqual(['claude', 'codex', 'gemini']);
  });

  it('never gives the critic role to the generator', () => {
    const a = scheduler().assign(4);
    expect(a?.critic).not.toBe(a?.generator);
  });

  it('skips a lane that is parked on a usage limit', () => {
    const s = scheduler();
    s.limited('claude', new Date(NOW.getTime() + 60_000));
    expect(s.assign(0)).toEqual({ generator: 'codex', critic: 'gemini', tiebreak: null });
  });

  it('writes only with the lanes allowed to generate', () => {
    const s = new LaneScheduler(['claude', 'codex', 'gemini'], { minGapMs: 0, now: () => NOW.getTime(), sleep: async () => undefined, generators: ['claude', 'codex'] });
    expect([0, 1, 2].map((i) => s.assign(i)?.generator)).toEqual(['claude', 'codex', 'claude']);
  });

  it('still uses a lane that may not generate as critic', () => {
    const s = new LaneScheduler(['claude', 'codex', 'gemini'], { minGapMs: 0, now: () => NOW.getTime(), sleep: async () => undefined, generators: ['claude', 'codex'] });
    expect(s.assign(2)).toEqual({ generator: 'claude', critic: 'gemini', tiebreak: 'codex' });
  });

  it('has no assignment while every lane allowed to generate is parked', () => {
    const s = new LaneScheduler(['claude', 'codex', 'gemini'], { minGapMs: 0, now: () => NOW.getTime(), sleep: async () => undefined, generators: ['claude'] });
    s.limited('claude', new Date(NOW.getTime() + 60_000));
    expect(s.assign(0)).toBeNull();
  });

  it('lets Claude and Codex write and keeps Gemini to judging by default', () => {
    expect(generatorsFor(['claude', 'codex', 'gemini'])).toEqual(['claude', 'codex']);
  });

  it('keeps the default to the lanes in use', () => {
    expect(generatorsFor(['codex', 'gemini'])).toEqual(['codex']);
  });

  it('honours an explicit list of writers', () => {
    expect(generatorsFor(['claude', 'codex', 'gemini'], ['gemini', 'claude'])).toEqual(['gemini', 'claude']);
  });

  it('refuses writers that are not among the lanes', () => {
    expect(() => generatorsFor(['claude', 'codex'], ['gemini'])).toThrow(/--generators/);
  });

  it('has no assignment when fewer than two lanes can run', () => {
    const s = scheduler(['claude', 'codex']);
    s.limited('codex', new Date(NOW.getTime() + 60_000));
    expect(s.assign(0)).toBeNull();
  });

  it('waits out the pacing gap between calls on one lane', async () => {
    const clock = { t: NOW.getTime() };
    const s = new LaneScheduler(['claude', 'codex'], { minGapMs: 5000, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
    await s.run('claude', async () => 1);
    await s.run('claude', async () => 2);
    expect(clock.t - NOW.getTime()).toBe(5000);
  });
});

describe('parsing replies', () => {
  it('drops a malformed question and keeps the rest', () => {
    const { questions, dropped } = parseQuestions('{"questions":[{"questionText":"short","form":"star","difficultyTag":2},{"questionText":"Walk me through how you run a settlement incident review?","form":"walkthrough","difficultyTag":2,"rationale":"r"}]}');
    expect([questions.length, dropped[0]?.reasons]).toEqual([1, ['malformed:questionText']]);
  });

  it('names a reply with no questions array', () => {
    expect(parseQuestions('I cannot help with that.').dropped[0]?.reasons).toEqual(['malformed:no_questions_array']);
  });

  it('matches verdicts by number and leaves a gap as null', () => {
    const verdict = { realQuestion: true, rightBand: true, answerable: true, formCorrect: true, anchorsLeaked: false, roleSpecific: true, confidence: 0.9, notes: '' };
    expect(parseVerdicts(JSON.stringify({ verdicts: [{ n: 2, ...verdict }] }), 2)).toEqual([null, verdict]);
  });
});

// --- The pool loop with scripted lanes ------------------------------------------------

const POOL: SeedPool = {
  key: 'payments-platform-engineer|incident-ownership|established',
  roleSlug: 'payments-platform-engineer', roleTitle: 'Payments Platform Engineer', familySlug: 'engineering-technical-delivery', familyName: 'Engineering / Technical Delivery',
  competencyKey: 'incident-ownership', competency: { name: 'Incident Ownership', definition: 'Runs payment incidents end to end.', indicators: ['Leads the incident call'], category: 'technical' },
  band: 'established', jdText: 'Shared catalog text.', target: 12, filled: 0, formCounts: {}, existingQuestions: [], standard: null,
};

const QUESTIONS = [
  'As a payments platform engineer, tell me about a settlement run you rescued: what failed first and what did you do?',
  'Walk me through how you would lead the first thirty minutes of a failed card settlement incident on this platform?',
];

function verdict(roleSpecific: boolean, n: number) {
  return { n, realQuestion: true, rightBand: true, answerable: true, formCorrect: true, anchorsLeaked: false, roleSpecific, confidence: roleSpecific ? 0.9 : 0.4, notes: '' };
}

/** A lane that answers each library prompt with a scripted reply, recognised by its system prompt. */
function scripted(lane: Lane, replies: { critic?: (count: number) => string; limitOn?: 'critic' } = {}): LlmProvider {
  return {
    name: lane, enabled: true,
    async generate(messages) {
      const system = messages[0]?.content ?? '';
      const user = messages[1]?.content ?? '';
      const reply = (text: string) => ({ text, model: lane, inputTokens: 0, outputTokens: 0, latencyMs: 5 });
      if (system.includes('scoring standards')) return reply('{"anchors":["Names what failed first and why","Says what changed in the runbook afterwards"],"weakSigns":["No example"]}');
      if (system.includes('independent reviewer')) {
        if (replies.limitOn === 'critic') throw new LaneLimitError(lane, new Date(NOW.getTime() + 3_600_000), true);
        const count = (user.match(/^\d+\. \[form:/gm) ?? []).length;
        return reply(replies.critic ? replies.critic(count) : JSON.stringify({ verdicts: Array.from({ length: count }, (_, i) => verdict(true, i + 1)) }));
      }
      return reply(JSON.stringify({ questions: QUESTIONS.map((q, i) => ({ questionText: q, form: i === 0 ? 'star' : 'walkthrough', difficultyTag: 2, rationale: 'Fits the role.' })) }));
    },
  };
}

function pipelineDeps(providers: Partial<Record<Lane, LlmProvider>>, s = scheduler()): PipelineDeps {
  return { scheduler: s, provider: (lane) => providers[lane] ?? scripted(lane), runId: 'test-run', now: () => NOW, perPool: 2, tiebreak: true, log: () => undefined };
}

const ASSIGN = { generator: 'codex', critic: 'claude', tiebreak: 'gemini' } as const;
const NO_STATE = { knownStandards: new Map(), alreadyAccepted: [] };

describe('runPool', () => {
  it('writes the family standard when the pool has none', async () => {
    const result = await runPool(POOL, ASSIGN, pipelineDeps({}), NO_STATE);
    expect(result.standard?.provenance.generatorLane).toBe('codex');
  });

  it('accepts questions the critic passes, as records the import can parse', async () => {
    const result = await runPool(POOL, ASSIGN, pipelineDeps({}), NO_STATE);
    expect(result.accepted.map((q) => parseSeedLine(JSON.stringify(q)).ok)).toEqual([true, true]);
  });

  it('accepts a question the critic failed when the third lane passes it, recording the tie-break', async () => {
    const critic = scripted('claude', { critic: (count) => JSON.stringify({ verdicts: Array.from({ length: count }, (_, i) => verdict(i !== 0, i + 1)) }) });
    const result = await runPool(POOL, ASSIGN, pipelineDeps({ claude: critic }), NO_STATE);
    expect(result.accepted.filter((q) => q.tiebreak).map((q) => q.provenance.tiebreakLane)).toEqual(['gemini']);
  });

  it('rejects a question both critics fail, with both reasons', async () => {
    const failing = (lane: Lane) => scripted(lane, { critic: (count) => JSON.stringify({ verdicts: Array.from({ length: count }, (_, i) => verdict(i !== 0, i + 1)) }) });
    const result = await runPool(POOL, ASSIGN, pipelineDeps({ claude: failing('claude'), gemini: failing('gemini') }), NO_STATE);
    expect(result.rejected[0]?.reasons).toEqual(expect.arrayContaining(['critic:generic', 'tiebreak:critic:generic']));
  });

  it('rejects without a tie-break when there is no third lane', async () => {
    const critic = scripted('claude', { critic: (count) => JSON.stringify({ verdicts: Array.from({ length: count }, (_, i) => verdict(i !== 0, i + 1)) }) });
    const result = await runPool(POOL, { generator: 'codex', critic: 'claude', tiebreak: null }, pipelineDeps({ claude: critic }), NO_STATE);
    expect(result.rejected.map((r) => r.stage)).toEqual(['critic']);
  });

  it('stops the pool and parks the critic lane on a usage limit', async () => {
    const s = scheduler();
    await expect(runPool(POOL, ASSIGN, pipelineDeps({ claude: scripted('claude', { limitOn: 'critic' }) }, s), NO_STATE)).rejects.toBeInstanceOf(PoolStageError);
    expect(s.usable('claude', NOW.getTime())).toBe(false);
  });
});

describe('runSeed', () => {
  const opts = { perPool: 2, concurrency: 1, tiebreak: true, maxAttempts: 2, maxWaitMs: 0 };
  function deps(providers: Partial<Record<Lane, LlmProvider>> = {}) {
    return { scheduler: scheduler(), provider: (lane: Lane) => providers[lane] ?? scripted(lane), now: () => NOW, sleep: async () => undefined, log: () => undefined, save: () => undefined, stopped: () => false };
  }

  it('fills every pending pool and writes a JSONL the import can parse', async () => {
    const { state } = await runSeed([POOL], withPools(newState('r', NOW), [POOL]), opts, deps());
    expect(jsonlFrom(state, [POOL.key]).trim().split('\n').map((l) => parseSeedLine(l).ok)).toEqual([true, true, true]);
  });

  it('skips a pool a previous run finished', async () => {
    const done = withPools(newState('r', NOW), [POOL]);
    const resumed = { ...done, pools: { [POOL.key]: { ...done.pools[POOL.key], status: 'done' as const } } };
    const { state } = await runSeed([POOL], resumed, opts, deps());
    expect(state.pools[POOL.key].accepted).toEqual([]);
  });

  it('marks a pool failed after its attempts run out', async () => {
    const broken: LlmProvider = { name: 'x', enabled: true, generate: async () => ({ text: 'not json', model: 'x', inputTokens: 0, outputTokens: 0, latencyMs: 1 }) };
    const { state } = await runSeed([POOL], withPools(newState('r', NOW), [POOL]), opts, deps({ claude: broken, codex: broken, gemini: broken }));
    expect(state.pools[POOL.key].status).toBe('failed');
  });

  it('stops rather than waits past the limit when every lane is parked', async () => {
    const d = deps();
    d.scheduler.limited('claude', new Date(NOW.getTime() + 3_600_000));
    d.scheduler.limited('codex', new Date(NOW.getTime() + 3_600_000));
    expect((await runSeed([POOL], withPools(newState('r', NOW), [POOL]), opts, d)).exit).toBe('lanes_unavailable');
  });
});

describe('summarize', () => {
  it('counts lane calls per accepted entry', async () => {
    const { state } = await runSeed([POOL], withPools(newState('r', NOW), [POOL]), { perPool: 2, concurrency: 1, tiebreak: true, maxAttempts: 1, maxWaitMs: 0 }, {
      scheduler: scheduler(), provider: (lane) => scripted(lane), now: () => NOW, sleep: async () => undefined, log: () => undefined, save: () => undefined, stopped: () => false,
    });
    const events = ['standard', 'generator', 'critic'].map((role, i) => ({ at: new Date(NOW.getTime() + i * 60_000).toISOString(), event: 'call', lane: 'codex', role, ok: true, ms: 1000 }));
    expect(summarize(state, events).callsPerAccepted).toBe(1.5);
  });
});
