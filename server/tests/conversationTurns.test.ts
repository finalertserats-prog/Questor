import { describe, it, expect } from 'vitest';
import type { Competency, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';
import { nextUtterance, type AgentUtterance } from '../src/engines/conversationRuntime.js';
import { coverageState, directorDecide } from '../src/engines/interviewDirector.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { CONFIRM_POSTPONE, CONFIRM_STOP, MOVE_ON_LEAD, PAUSE_REPLY, POSTPONE_REPLY } from '../src/engines/conversationModel.js';

// The interviewer answers what the candidate actually said, turn by turn, on
// the built-in (no model) path. Each case is a moment from a production
// transcript where it did not.

function competency(id: string, name: string, category: Competency['category'], weight: number): Competency {
  return { id, name, definition: '', category, classification: 'essential', weight, requiredLevel: 3, targetLevel: 4, indicators: [], evidenceModes: [] };
}

const ROLE: RoleSuccessProfile = {
  roleContext: 'Deliver online survey projects for research teams.',
  outcomes: [],
  responsibilities: ['Manage end-to-end delivery of online survey projects', 'Coordinate timelines with research managers and clients'],
  competencies: [
    competency('c_pm', 'Project Management', 'behavioral', 0.4),
    competency('c_prog', 'Survey Programming', 'technical', 0.3),
    competency('c_tools', 'Technical Proficiency in Survey Tools', 'technical', 0.3),
  ],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [],
  seniority: 'Manager',
};

const plan = buildInterviewPlan({ role: ROLE, durationMinutes: 30 });

/** A tiny in-memory engine: the director, then the runtime, exactly as interviewEngine calls them. */
class Conversation {
  turns: TurnRecord[] = [];
  last!: AgentUtterance;

  private push(speaker: TurnRecord['speaker'], text: string, competencyId: string, kind?: string) {
    const i = this.turns.length;
    this.turns.push({ id: `t${i}`, index: i, speaker, text, startMs: i * 40_000, endMs: i * 40_000 + 30_000, confidence: 1, competencyId, ...(kind ? { kind } : {}) });
  }

  async agent(): Promise<AgentUtterance> {
    const signal = directorDecide({ plan, turns: this.turns, elapsedMinutes: this.turns.length * 0.66 });
    this.last = await nextUtterance({ plan, signal, turns: this.turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' }, candidateName: 'K JAYESH RAHUL', roleTitle: 'Project Manager - Survey Delivery' });
    this.push('agent', this.last.text, this.last.competencyId, this.last.kind);
    return this.last;
  }

  /** Put a specific question, so a shape the bank does not produce can be tested. */
  ask(text: string, competencyId = 'c_prog') {
    this.push('agent', text, competencyId, 'question');
  }

  async say(text: string): Promise<AgentUtterance> {
    const lastAgent = [...this.turns].reverse().find((t) => t.speaker === 'agent');
    this.push('candidate', text, lastAgent?.competencyId ?? '');
    return this.agent();
  }
}

const REAL_ANSWER = 'I manage survey delivery for three research teams, and I script most trackers in Decipher myself.';

async function intoFirstCompetency(): Promise<Conversation> {
  const c = new Conversation();
  await c.agent();
  await c.say(REAL_ANSWER);
  return c;
}

describe('ending turns', () => {
  it('greets "K JAYESH RAHUL" as Jayesh', async () => {
    const c = new Conversation();
    const opening = await c.agent();
    expect(opening.text).toMatch(/^Hi Jayesh\b/);
  });

  it('ends the interview on a typed "Stop"', async () => {
    const c = await intoFirstCompetency();
    const u = await c.say('Stop');
    expect(u.kind).toBe('withdrawn');
  });

  it('ends politely, unscored, when the candidate asks to do it later', async () => {
    const c = new Conversation();
    await c.agent();
    const u = await c.say('Now can we have this interview later');
    expect(u.kind).toBe('postponed');
    expect(u.text).toBe(POSTPONE_REPLY);
  });
});

describe('pause', () => {
  it('acknowledges and asks nothing new', async () => {
    const c = await intoFirstCompetency();
    const asked = c.last;
    const u = await c.say('Pause');
    expect(u.kind).toBe('pause');
    expect(u.text).toBe(PAUSE_REPLY);
    expect(u.competencyId).toBe(asked.competencyId);
  });

  it('comes back to the same question when the candidate is ready', async () => {
    const c = await intoFirstCompetency();
    const asked = c.last;
    await c.say('Pause');
    const u = await c.say('ready');
    expect(u.kind).toBe('reask');
    expect(u.text).toContain(asked.text.replace(/^.*?(?=Tell|Let|When|Walk|In |Think|Suppose|What)/, '').slice(0, 30));
  });
});

describe('non-answers', () => {
  it('rephrases more simply instead of following up on "Oh"', async () => {
    const c = await intoFirstCompetency();
    const asked = c.last;
    const u = await c.say('Oh');
    expect(u.kind).toBe('rephrase');
    expect(u.competencyId).toBe(asked.competencyId);
  });

  it('moves on after two non-answers in a row, without scoring them', async () => {
    const c = await intoFirstCompetency();
    const asked = c.last;
    await c.say('No');
    const u = await c.say('Nothing');
    expect(u.text.startsWith(MOVE_ON_LEAD)).toBe(true);
    expect(u.competencyId).not.toBe(asked.competencyId);
  });

  it('does not count a non-answer towards the block', async () => {
    const c = await intoFirstCompetency();
    const block = c.last.competencyId;
    const before = coverageState(plan, c.turns)[block] ?? 0;
    await c.say('Oh');
    expect(coverageState(plan, c.turns)[block] ?? 0).toBe(before);
  });

  it('treats "Welcome back" as nothing to follow up on', async () => {
    const c = await intoFirstCompetency();
    const u = await c.say('Welcome back');
    expect(u.kind).toBe('rephrase');
  });
});

describe('a bare yes or no', () => {
  // "Yes." to "Did you write the scripts yourself?" is an answer. Treating it
  // as an empty turn rephrased the question and dropped the answer from the
  // evidence a reviewer reads.
  it('answers a yes/no question, and earns a follow-up rather than a rephrase', async () => {
    const c = await intoFirstCompetency();
    c.ask('Did you personally write the survey scripts?');
    const u = await c.say('Yes.');
    expect(u.kind).toBe('followup');
    expect(coverageState(plan, c.turns).c_prog).toBeGreaterThan(0);
  });

  it('still says nothing when the question was open', async () => {
    const c = await intoFirstCompetency();
    c.ask('Walk me through how you QA a survey script before it goes to field.');
    const u = await c.say('Yes');
    expect(u.kind).toBe('rephrase');
  });

  // The predicate uses a word the account-request list also uses; the question
  // is still a yes/no question, and "Yes." is still the answer to it.
  it('counts "Yes." to "Did you share the tracker with the client?"', async () => {
    const c = await intoFirstCompetency();
    c.ask('Did you share the tracker with the client?');
    const u = await c.say('Yes.');
    expect(u.kind).toBe('followup');
    expect(coverageState(plan, c.turns).c_prog).toBeGreaterThan(0);
  });

  it('is nothing when the question invited an example, however it opened', async () => {
    const c = await intoFirstCompetency();
    c.ask('Is there an example you can share?');
    const before = coverageState(plan, c.turns).c_prog ?? 0;
    const u = await c.say('Yes.');
    expect(u.kind).toBe('rephrase');
    expect(coverageState(plan, c.turns).c_prog ?? 0).toBe(before);
  });

  it('follows up on "No" by asking what their part was', async () => {
    const c = await intoFirstCompetency();
    c.ask('Did you personally write the survey scripts?');
    const u = await c.say('No');
    expect(u.kind).toBe('followup');
    expect(u.text).toMatch(/who|your (own )?(part|involvement)/i);
  });
});

describe('an unclear ending cue is confirmed, not acted on', () => {
  it('asks one short confirming question and waits', async () => {
    const c = await intoFirstCompetency();
    const asked = c.last;
    const u = await c.say('I might have to stop soon');
    expect(u.kind).toBe('confirm');
    expect(u.text).toBe(CONFIRM_STOP);
    expect(u.competencyId).toBe(asked.competencyId);
  });

  it('ends when the candidate confirms', async () => {
    const c = await intoFirstCompetency();
    await c.say('I might have to stop soon');
    const u = await c.say('yes');
    expect(u.kind).toBe('withdrawn');
  });

  it('carries on with the same question when they say no, and scores nothing for the detour', async () => {
    const c = await intoFirstCompetency();
    const asked = c.last;
    const before = coverageState(plan, c.turns)[asked.competencyId] ?? 0;
    await c.say('I might have to stop soon');
    const u = await c.say('no, carry on');
    expect(u.kind).toBe('reask');
    expect(u.text).toContain(asked.question ?? asked.text);
    // The confirm and its answer are conversation, not evidence: only the
    // ambiguous turn itself, which carried real content, may count.
    expect(coverageState(plan, c.turns)[asked.competencyId] ?? 0).toBeLessThanOrEqual(before + 1);
  });

  it('does not confirm twice in a row for the same cue', async () => {
    const c = await intoFirstCompetency();
    await c.say('I might have to stop soon');
    const u = await c.say('I might have to stop soon');
    expect(u.kind).not.toBe('confirm');
  });

  it('offers to pick it up another time when the cue was a postponement', async () => {
    const c = await intoFirstCompetency();
    const u = await c.say('maybe another time would be better');
    expect(u.text).toBe(CONFIRM_POSTPONE);
    const end = await c.say('yes please');
    expect(end.kind).toBe('postponed');
  });

  it('still ends immediately on a clear one', async () => {
    const c = await intoFirstCompetency();
    const u = await c.say('stop, I need to go');
    expect(u.kind).toBe('withdrawn');
  });
});

describe('an invitation to tell a story', () => {
  it('asks the candidate to go ahead when they answer "Yes", and scores nothing', async () => {
    const c = await intoFirstCompetency();
    c.ask('Do you have a recent project you can walk me through?');
    const before = coverageState(plan, c.turns).c_prog ?? 0;
    const u = await c.say('Yes.');
    expect(u.text).toMatch(/go ahead/i);
    expect(coverageState(plan, c.turns).c_prog ?? 0).toBe(before);
  });
});

describe('work the candidate wants to change is not a request to stop', () => {
  it.each([
    'I need to stop using Excel for tracker delivery',
    'I want to end the manual process',
    'I would like to stop relying on vendors',
  ])('carries on after "%s"', async (said) => {
    const c = await intoFirstCompetency();
    const u = await c.say(said);
    expect(u.kind).not.toBe('withdrawn');
    expect(u.kind).not.toBe('postponed');
  });
});

describe('asking for another time, without a model', () => {
  it.each([
    "I'll do it later",
    'I can come back after exams',
    'could we pick this up once my exams are over',
    "let's continue another day",
    "I'm not free right now, later?",
  ])('ends politely on "%s"', async (said) => {
    const c = await intoFirstCompetency();
    const u = await c.say(said);
    expect(u.kind).toBe('postponed');
    expect(u.text).toBe(POSTPONE_REPLY);
  });
});

describe('corrections', () => {
  it('thanks the candidate and asks again, never arguing', async () => {
    const c = await intoFirstCompetency();
    const u = await c.say("I think you got it wrong, I didn't say that");
    expect(u.text).toMatch(/^Thanks for clarifying/);
    expect(u.kind).toBe('reask');
  });
});

describe('candidate questions', () => {
  it('answers from the role, then goes back to the question', async () => {
    const c = await intoFirstCompetency();
    const asked = c.last;
    const u = await c.say('what does this role involve day to day?');
    expect(u.kind).toBe('candidate_answer');
    expect(u.text).toMatch(/delivery of online survey projects/i);
    expect(u.competencyId).toBe(asked.competencyId);
  });

  it('answers the closing question before signing off', async () => {
    const c = await intoFirstCompetency();
    for (let i = 0; i < 20 && c.last.kind !== 'close'; i++) {
      await c.say('In that project I planned the timeline with the research manager, scripted the survey in Decipher, and delivered it two days early.');
    }
    expect(c.last.kind).toBe('close');
    const u = await c.say("what exact role are you looking for, because a few questions asked about taking decisions on custom solutions, this is usually the research manager's call");
    expect(u.kind).toBe('signoff');
    expect(u.text).toMatch(/Project Manager/);
    expect(u.text).toMatch(/hiring team can clarify/i);
  });

  it('signs off on "No" at the close rather than rephrasing it', async () => {
    const c = await intoFirstCompetency();
    for (let i = 0; i < 20 && c.last.kind !== 'close'; i++) {
      await c.say('In that project I planned the timeline with the research manager, scripted the survey in Decipher, and delivered it two days early.');
    }
    const u = await c.say('No');
    expect(u.kind).toBe('signoff');
  });
});

describe('acknowledgement', () => {
  it('names something the candidate actually said before the next question', async () => {
    const c = await intoFirstCompetency();
    expect(c.last.text).toContain('Decipher');
  });
});

describe('grounded in the role', () => {
  it('asks the Project Manager only about its own competencies', async () => {
    const c = await intoFirstCompetency();
    for (let i = 0; i < 20 && c.last.kind !== 'close'; i++) {
      await c.say('In that project I planned the timeline with the research manager, scripted the survey in Decipher, and delivered it two days early.');
    }
    const questions = c.turns.filter((t) => t.speaker === 'agent' && t.competencyId?.startsWith('c_')).map((t) => t.text);
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) expect(q).not.toMatch(/build[- ]?(?:versus|vs|or)[- ]?buy|architecture|long-term consequence/i);
  });
});
