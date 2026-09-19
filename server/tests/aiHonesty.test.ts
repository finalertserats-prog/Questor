import { describe, it, expect } from 'vitest';
import type { Competency, DirectorSignal, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';
import { detectAiIdentityQuestion, detectRepeatRequest } from '../src/engines/policyEngine.js';
import { AI_IDENTITY_ANSWER, nextUtterance } from '../src/engines/conversationRuntime.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { directorDecide } from '../src/engines/interviewDirector.js';

// The opening no longer announces the AI (the consent screen does), so the
// interviewer must never let a direct question go unanswered or be answered
// falsely: asked whether it is an AI, a bot or a person, it says it is an AI
// and that a person reviews the interview, then carries on.

const TECH: Competency = {
  id: 'c_tech', name: 'Data Engineering & Pipelines', definition: '', category: 'technical',
  classification: 'essential', weight: 1, requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: [],
};
const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [], competencies: [TECH],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};
const PLAN = buildInterviewPlan({ role: ROLE, durationMinutes: 45 });

function signal(over: Partial<DirectorSignal> = {}): DirectorSignal {
  return { nextCompetencyId: TECH.id, action: 'followup', depthInstruction: 'hold', timeRemainingMinutes: 20, coverageState: { [TECH.id]: 1 }, reason: 't', ...over };
}

function turns(candidateText: string): TurnRecord[] {
  return [
    { id: 'a', index: 0, speaker: 'agent', text: 'Tell me about a pipeline you owned.', startMs: 0, endMs: 1, confidence: 1, competencyId: TECH.id },
    { id: 'b', index: 1, speaker: 'candidate', text: candidateText, startMs: 1, endMs: 2, confidence: 1, competencyId: TECH.id },
  ];
}

describe('detectAiIdentityQuestion', () => {
  it.each([
    'Are you an AI?',
    'Wait, am I talking to a bot?',
    'Is this a real person?',
    'are you human',
    'Sorry — is this an actual person or a machine?',
    'Am I speaking with a recording or a real interviewer?',
    'Are you a robot?',
    'Are you real?',
    "You're not a real person, are you?",
    'Is this automated?',
    'Is there a human on the other end?',
    'Are you ChatGPT?',
    'Who am I talking to?',
    "Hang on, you're a bot, right?",
    'Is this an AI interviewer?',
    'Are you a real person or a bot?',
    'Are you human, though?',
  ])('recognises "%s"', (text) => {
    expect(detectAiIdentityQuestion(text)).toBe(true);
  });

  it.each([
    'I built an AI pipeline for fraud detection.',
    'We used the Bot Framework for the support channel.',
    'A real person on my team reviewed every change.',
    'Are you able to repeat the question?',
    'Is it a human-centred design role?',
    'Is that the person who approves the budget?',
    'I automated the billing reconciliation last year.',
    'Our chatbot is a real product used by millions.',
    // The subject word followed by a noun is a question about the job.
    'Is this a machine learning team?',
    'Is it a computer vision role?',
    'Is that program in Java?',
    'Is it automated testing?',
    'Are you an AI-first company?',
  ])('ignores "%s"', (text) => {
    expect(detectAiIdentityQuestion(text)).toBe(false);
  });
});

describe('the interviewer answers truthfully', () => {
  it('says it is an AI and that a person reviews the interview', () => {
    expect(AI_IDENTITY_ANSWER).toBe("Yes — I'm an AI interviewer; a person on the hiring team reviews everything.");
  });

  it('opens its next turn with the truthful answer', async () => {
    const u = await nextUtterance({ plan: PLAN, signal: signal(), turns: turns('Before I answer — are you a real person?'), role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(u.text.startsWith(AI_IDENTITY_ANSWER)).toBe(true);
  });

  it('then carries on with the interview', async () => {
    const u = await nextUtterance({ plan: PLAN, signal: signal(), turns: turns('Are you an AI?'), role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(u.text.slice(AI_IDENTITY_ANSWER.length).trim().length).toBeGreaterThan(20);
  });

  it('never claims to be human', async () => {
    const u = await nextUtterance({ plan: PLAN, signal: signal(), turns: turns('Is this a real person?'), role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(u.text).not.toMatch(/I'?m (a )?(real )?(person|human)|I am (a )?(real )?(person|human)/i);
  });

  it('adds nothing when the candidate did not ask', async () => {
    const u = await nextUtterance({ plan: PLAN, signal: signal(), turns: turns('I owned the nightly billing pipeline end to end.'), role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(u.text).not.toContain(AI_IDENTITY_ANSWER);
  });

  it('still lets a withdrawal win over the identity question', async () => {
    const u = await nextUtterance({ plan: PLAN, signal: signal(), turns: turns('Are you a bot? I want to stop the interview.'), role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(u.kind).toBe('withdrawn');
  });
});

describe('detectRepeatRequest', () => {
  it.each(['Sorry, could you repeat that?', 'Can you say that again?', 'Pardon?', 'What was the question?', 'Come again?'])('recognises "%s"', (text) => {
    expect(detectRepeatRequest(text)).toBe(true);
  });

  it('ignores an answer that mentions repeating something', () => {
    expect(detectRepeatRequest('We had to repeat the backfill twice before the numbers matched.')).toBe(false);
  });
});

describe('the combined opening', () => {
  function afterOpening(reply: string): TurnRecord[] {
    return [
      { id: 'a', index: 0, speaker: 'agent', text: 'Hi Priya, I\'m Maya — …', startMs: 0, endMs: 1, confidence: 1, competencyId: '__process__' },
      { id: 'b', index: 1, speaker: 'candidate', text: reply, startMs: 1, endMs: 2, confidence: 1, competencyId: '__process__' },
    ];
  }

  it('does not count a request to repeat as the warm-up answer', () => {
    expect(directorDecide({ plan: PLAN, turns: afterOpening('Sorry, could you repeat that?'), elapsedMinutes: 1 }).nextCompetencyId).toBe('__process__');
  });

  it('does not count "are you an AI?" as the warm-up answer', () => {
    expect(directorDecide({ plan: PLAN, turns: afterOpening('Wait — are you an AI?'), elapsedMinutes: 1 }).nextCompetencyId).toBe('__process__');
  });

  it('puts the opening question again without greeting a second time', async () => {
    const turns = afterOpening('Sorry, could you repeat that?');
    const signal = directorDecide({ plan: PLAN, turns, elapsedMinutes: 1 });
    const u = await nextUtterance({ plan: PLAN, signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(u.text).toBe("Could you briefly tell me about your current role and the project you've worked on that's most relevant to this position?");
  });

  it('answers the identity question, then puts the opening question again', async () => {
    const turns = afterOpening('Wait — are you an AI?');
    const signal = directorDecide({ plan: PLAN, turns, elapsedMinutes: 1 });
    const u = await nextUtterance({ plan: PLAN, signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(u.text).toBe(`${AI_IDENTITY_ANSWER} Could you briefly tell me about your current role and the project you've worked on that's most relevant to this position?`);
  });

  it('counts the answer to the opening as the warm-up answer, so the warm-up is not asked twice', () => {
    const answered: TurnRecord[] = [
      { id: 'a', index: 0, speaker: 'agent', text: 'Hi Priya, I\'m Maya — …', startMs: 0, endMs: 1, confidence: 1, competencyId: '__process__' },
      { id: 'b', index: 1, speaker: 'candidate', text: 'I lead the data platform team at FinEdge.', startMs: 1, endMs: 2, confidence: 1, competencyId: '__process__' },
    ];
    expect(directorDecide({ plan: PLAN, turns: answered, elapsedMinutes: 1 }).nextCompetencyId).not.toBe('__warmup__');
  });
});
