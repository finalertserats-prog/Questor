import { describe, it, expect } from 'vitest';
import {
  DEMO_CAP_MS, DEMO_CLOSING_RESERVE_MS, DEMO_EXTENSION_MS, DEMO_MODES, DEMO_STAGES,
  beforeYouStartLine, capAtFor, endReasonLabel, furtherStage, isDemoMode, mayExtend, modeLabel,
  movingToCloseLine, msLeft, mustFinalise, mustStopAsking, signalClosedForTimeBox, stageLabel,
  staysInCharacter, systemShapedMatches,
} from '../src/domain/demoInterview.js';
import {
  DEMO_SPEND_PER_DAY, DEMO_SPEND_PER_RUN, isSpendableFunction, maySpend, refusalIsNotable,
  spendDayKey, spendVerdict,
} from '../src/domain/demoBudget.js';
import { DEMO_OBSERVER_SCRIPT, scriptDurationMs, scriptedAnswers } from '../src/domain/demoObserverScript.js';
import type { DirectorSignal } from '../src/domain/types.js';

// The demo's time box, budget and wording, as pure logic. Everything the
// server refuses to do once the clock or the ceiling runs out is decided here,
// so it can be reasoned about without a database, a socket or a model.

const T0 = new Date('2026-09-24T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const run = (extendedMs = 0, endedAt: Date | null = null) => ({ startedAt: T0, capAt: capAtFor(T0, extendedMs), extendedMs, endedAt });

describe('the demo modes', () => {
  it('offers exactly the two modes the visitor is asked to choose between', () => {
    expect(DEMO_MODES).toEqual(['candidate', 'observer']);
  });

  it('refuses a mode it does not offer', () => {
    expect(isDemoMode('observer')).toBe(true);
    expect(isDemoMode('interviewer')).toBe(false);
  });

  it('names each mode the way the choice screen names it', () => {
    expect(modeLabel('candidate')).toBe('Be the candidate');
    expect(modeLabel('observer')).toBe('Watch one happen');
  });
});

describe('the fifteen-minute cap', () => {
  it('is fifteen minutes', () => {
    expect(DEMO_CAP_MS).toBe(15 * 60_000);
  });

  it('puts the cap fifteen minutes after the sitting started', () => {
    expect(capAtFor(T0).toISOString()).toBe(at(DEMO_CAP_MS).toISOString());
  });

  it('carries an extension into the cap', () => {
    expect(capAtFor(T0, DEMO_EXTENSION_MS).toISOString()).toBe(at(DEMO_CAP_MS + DEMO_EXTENSION_MS).toISOString());
  });

  it('keeps asking questions while there is more than the closing reserve left', () => {
    expect(mustStopAsking(at(DEMO_CAP_MS - DEMO_CLOSING_RESERVE_MS - 1), run())).toBe(false);
  });

  // The whole interview has to FIT in fifteen minutes, so the interviewer is
  // sent to its close early enough to finish the closing exchange inside the
  // box. Stopping at the cap itself would end it at eighteen minutes.
  it('stops asking new questions once only the closing reserve is left', () => {
    expect(mustStopAsking(at(DEMO_CAP_MS - DEMO_CLOSING_RESERVE_MS), run())).toBe(true);
  });

  it('does not finalise merely because the close has begun', () => {
    expect(mustFinalise(at(DEMO_CAP_MS - 1), run())).toBe(false);
  });

  it('finalises at the cap', () => {
    expect(mustFinalise(at(DEMO_CAP_MS), run())).toBe(true);
  });

  it('never acts twice on a sitting that has already ended', () => {
    const ended = run(0, at(DEMO_CAP_MS - 60_000));
    expect(mustStopAsking(at(DEMO_CAP_MS), ended)).toBe(false);
    expect(mustFinalise(at(DEMO_CAP_MS), ended)).toBe(false);
  });

  it('reports the time left, and never a negative one', () => {
    expect(msLeft(at(60_000), run())).toBe(DEMO_CAP_MS - 60_000);
    expect(msLeft(at(DEMO_CAP_MS + 60_000), run())).toBe(0);
  });
});

describe('the extension anyone may take', () => {
  // Offered to every visitor with no reason asked, precisely so that taking it
  // is not a disclosure. Someone reading with a screen reader, typing rather
  // than speaking, or thinking at their own pace must not have to explain that.
  it('is available before it has been used', () => {
    expect(mayExtend(run())).toBe(true);
  });

  it('is available only once', () => {
    expect(mayExtend(run(DEMO_EXTENSION_MS))).toBe(false);
  });

  it('is not available after the sitting has ended', () => {
    expect(mayExtend(run(0, at(1000)))).toBe(false);
  });
});

describe('how far the visitor got', () => {
  it('only ever moves forwards', () => {
    expect(furtherStage('interviewing', 'consented')).toBe('interviewing');
    expect(furtherStage('consented', 'interviewing')).toBe('interviewing');
  });

  it('has a plain label for every stage it can record', () => {
    for (const stage of DEMO_STAGES) expect(stageLabel(stage).length).toBeGreaterThan(0);
  });

  it('says plainly why a sitting ended', () => {
    expect(endReasonLabel('cap')).toBe('Reached the 15-minute demo limit');
    expect(endReasonLabel('abandoned')).toBe('Closed the tab part-way');
    expect(endReasonLabel('engine_unavailable')).toBe('The interviewer could not run');
  });
});

describe('what the visitor is told, and when', () => {
  // The bound is stated ONCE, before they choose. Saying it there is what buys
  // the right to say nothing during the interview.
  it('says how long the demo runs, before it starts, in both modes', () => {
    for (const mode of DEMO_MODES) expect(beforeYouStartLine(mode)).toMatch(/15 minutes/);
  });

  it('tells a visitor who is about to answer that they may take longer', () => {
    expect(beforeYouStartLine('candidate')).toMatch(/take longer/i);
  });
});

describe('the interviewer never breaks character', () => {
  // Owner, 2026-09-24: no "your limit has been reached" mid-interview. Every
  // boundary is something the interviewer SAYS, moving the conversation along.
  it('moves to the close in the interviewer\'s own voice', () => {
    expect(movingToCloseLine()).toMatch(/demo interview/i);
    expect(movingToCloseLine()).toMatch(/close/i);
  });

  it('carries no system, error or billing wording', () => {
    expect(systemShapedMatches(movingToCloseLine())).toEqual([]);
    expect(staysInCharacter(movingToCloseLine())).toBe(true);
  });

  it('catches the wording somebody would add because it is true', () => {
    expect(staysInCharacter('Your demo limit has been reached.')).toBe(false);
    expect(staysInCharacter('The model provider is unavailable.')).toBe(false);
    expect(staysInCharacter('Sorry, something went wrong. Please try again.')).toBe(false);
  });

  it('does not flag ordinary interviewer speech', () => {
    expect(staysInCharacter('Walk me through the last time one of those pipelines broke.')).toBe(true);
  });
});

describe('the spend ceiling', () => {
  const state = (over: Partial<Parameters<typeof spendVerdict>[1]> = {}) =>
    ({ mode: 'candidate', ended: false, runSpent: 0, reserved: DEMO_SPEND_PER_RUN, ...over });

  // EXACTLY ONE function, which is the literal reading of what the owner
  // authorised. candidate_intent was in here on a good argument; a budget
  // exception that grows by good argument stops being an exception.
  it('spends only on the interviewer reacting to what was said', () => {
    expect(isSpendableFunction('live_interviewer')).toBe(true);
    expect(isSpendableFunction('candidate_intent')).toBe(false);
  });

  it('never spends on the scaffolding, the grading or the written report', () => {
    for (const fn of ['candidate_question', 'competency_grader', 'report_writer', 'role_extraction', 'candidate_intent']) {
      expect(spendVerdict(fn, state())).toBe('not_reactive');
    }
  });

  it('never spends in observer mode, which is a written script', () => {
    expect(spendVerdict('live_interviewer', state({ mode: 'observer' }))).toBe('not_candidate_mode');
  });

  it('never spends on a sitting that has ended', () => {
    expect(spendVerdict('live_interviewer', state({ ended: true }))).toBe('ended');
  });

  it('stops at what this sitting reserved, not at a global count', () => {
    expect(maySpend('live_interviewer', state({ runSpent: DEMO_SPEND_PER_RUN - 1 }))).toBe(true);
    expect(spendVerdict('live_interviewer', state({ runSpent: DEMO_SPEND_PER_RUN }))).toBe('run_exhausted');
  });

  // A sitting that reserved nothing may spend nothing — which is what makes
  // "the day is full" a decision taken before the start rather than during.
  it('spends nothing at all when the sitting reserved nothing', () => {
    expect(spendVerdict('live_interviewer', state({ reserved: 0 }))).toBe('run_exhausted');
  });

  it('keys the day counter on the calendar day in UTC', () => {
    expect(spendDayKey(new Date('2026-09-24T23:59:59.000Z'))).toBe('2026-09-24');
    expect(spendDayKey(new Date('2026-09-25T00:00:01.000Z'))).toBe('2026-09-25');
  });

  it('reserves whole sittings out of the day, not single calls', () => {
    expect(DEMO_SPEND_PER_DAY % DEMO_SPEND_PER_RUN).toBe(0);
    expect(DEMO_SPEND_PER_DAY / DEMO_SPEND_PER_RUN).toBe(20);
  });

  it('treats a sitting outrunning its allowance as worth an operator knowing', () => {
    expect(refusalIsNotable('run_exhausted')).toBe(true);
    expect(refusalIsNotable('not_reactive')).toBe(false);
  });
});

describe('the written interview an observer watches', () => {
  it('alternates interviewer and candidate, starting and ending with the interviewer', () => {
    expect(DEMO_OBSERVER_SCRIPT[0].speaker).toBe('agent');
    expect(DEMO_OBSERVER_SCRIPT[DEMO_OBSERVER_SCRIPT.length - 1].speaker).toBe('agent');
    for (let i = 1; i < DEMO_OBSERVER_SCRIPT.length; i += 1) {
      expect(DEMO_OBSERVER_SCRIPT[i].speaker).not.toBe(DEMO_OBSERVER_SCRIPT[i - 1].speaker);
    }
  });

  // The observer must see an interview that ENDS, not one that runs out of
  // time: the time box should never have to intervene on a scripted sitting.
  it('finishes comfortably inside the fifteen-minute box', () => {
    expect(scriptDurationMs()).toBeLessThan(DEMO_CAP_MS - DEMO_CLOSING_RESERVE_MS);
  });

  it('is paced like a conversation, not a document', () => {
    expect(DEMO_OBSERVER_SCRIPT.every((line) => line.afterMs >= 1_000)).toBe(true);
    const candidatePauses = DEMO_OBSERVER_SCRIPT.filter((l) => l.speaker === 'candidate').map((l) => l.afterMs);
    const agentPauses = DEMO_OBSERVER_SCRIPT.filter((l) => l.speaker === 'agent').map((l) => l.afterMs);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(candidatePauses)).toBeGreaterThan(mean(agentPauses));
  });

  // The whole reason the mode is worth watching: the assessment afterwards has
  // to have something to say. A candidate who is excellent at everything
  // teaches a prospect nothing about the scoring.
  it('has one genuinely thin answer among strong ones', () => {
    const answers = scriptedAnswers();
    const thin = answers.filter((a) => /that's not been mine|never/i.test(a.text));
    expect(thin.length).toBeGreaterThanOrEqual(1);
    expect(answers.length).toBeGreaterThanOrEqual(6);
  });

  it('gives the evaluator evidence spread over more than one competency', () => {
    const competencies = new Set(scriptedAnswers().map((a) => a.competencyId).filter((c) => c && !c.startsWith('__')));
    expect(competencies.size).toBeGreaterThanOrEqual(3);
  });

  it('says nothing in the interviewer\'s turns that breaks character', () => {
    for (const line of DEMO_OBSERVER_SCRIPT.filter((l) => l.speaker === 'agent')) {
      expect({ text: line.text, matched: systemShapedMatches(line.text) }).toEqual({ text: line.text, matched: [] });
    }
  });

  // Live observation is only permitted where the candidate was told. The
  // script says it out loud in its opening, which is the same server-side
  // proof a real interview has to produce.
  it('has the interviewer speak the observation notice in its opening', () => {
    expect(DEMO_OBSERVER_SCRIPT[0].text).toMatch(/hiring team may observe this interview live/i);
  });
});

describe('sending the interviewer to its close', () => {
  const asking: DirectorSignal = {
    nextCompetencyId: 'delivery',
    action: 'probe',
    depthInstruction: 'deepen',
    timeRemainingMinutes: 9,
    coverageState: { delivery: 1 },
    reason: 'Block under quota.',
  };

  it('turns any decision into the close the director already knows how to make', () => {
    const closed = signalClosedForTimeBox(asking);
    expect(closed.action).toBe('close');
    expect(closed.nextCompetencyId).toBe('__candidate_questions__');
    expect(closed.depthInstruction).toBe('hold');
    expect(closed.timeRemainingMinutes).toBe(0);
  });

  it('keeps the coverage the director measured, so the assessment still sees it', () => {
    expect(signalClosedForTimeBox(asking).coverageState).toEqual({ delivery: 1 });
  });

  it('leaves a decision that was already to close exactly as it was', () => {
    const closing: DirectorSignal = { ...asking, action: 'close', nextCompetencyId: '__candidate_questions__', reason: 'All planned competencies covered.' };
    expect(signalClosedForTimeBox(closing).reason).toBe('All planned competencies covered.');
  });
});
