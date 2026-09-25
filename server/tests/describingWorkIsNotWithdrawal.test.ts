import { describe, it, expect } from 'vitest';
import { ENDING_INTENTS, detectCandidateIntent } from '../src/engines/candidateIntent.js';
import { detectWithdrawal } from '../src/engines/policyEngine.js';

// The sentences a competency interview is FOR.
//
// An audit ran the shipped patterns over ordinary professional speech and 36 of
// 44 answers ended the interview with no assessment. "I finished the migration
// in March" was read as "I'm finished"; "I have to run the numbers first" as "I
// have to run"; "we had to end the call with the vendor" as "end the call".
// Describing work you completed is the single most common thing a candidate
// does in a competency interview, so every one of these cost somebody their
// interview and their reason for being here.
//
// The corpus is deliberately drawn from several fields rather than from
// software alone: the patterns are written in English, not in job titles, and a
// nurse describing a handover trips exactly the same alternative as an engineer
// describing a cutover. A phrase list that only ever sees one trade's
// vocabulary is how these got through in the first place.
const DESCRIBING_WORK = [
  // Software and data.
  'I finished the migration in March and the old cluster was decommissioned in April.',
  'I finished my degree in 2019 and joined the platform team straight after.',
  "I'm done with the backfill, then I moved to the API rewrite.",
  'I finished the rollout ahead of schedule because we scripted the cutover.',
  'I need to go back to 2019 to explain how the schema ended up that way.',
  'I have to run the numbers first before I can give you a figure.',
  'I am done with the first phase and the second one starts in October.',
  "On the migration I'll continue the backfill tomorrow, my colleague covers the weekend.",
  'I will continue the analysis tomorrow, my colleague covers the weekend.',
  // Nursing.
  'I finished my shift handover and then escalated the case to the registrar.',
  'I have to run the observations every four hours on that ward.',
  'We had to stop the transfusion when the patient spiked a temperature.',
  'I need to go through the drug chart with a second nurse before anything is given.',
  'I finished the placement in the respiratory ward before I specialised.',
  // Teaching.
  'I finished the syllabus two weeks early so we used the time for revision.',
  'I have to run the assessment again for the students who were absent.',
  'I need to go over the marking scheme with the department first.',
  "I'm done with the lesson plans for this term, next term is still open.",
  // Logistics and operations.
  'I finished the depot audit in six weeks instead of eight.',
  'We had to end the night shift early because the freezer failed.',
  'I have to run the route plan past the transport manager.',
  'I need to go back to the supplier before I can commit to that lead time.',
  'I finished the stock count, then reconciled the variances with finance.',
  // Finance and audit.
  'I finished the year end close three days ahead of the deadline.',
  'I have to run the reconciliation before the numbers mean anything.',
  'I need to go through the ledger line by line when a variance shows up.',
  'We rescheduled the audit fieldwork for the following quarter.',
  'I need to reschedule the client demo whenever a release slips.',
  // Construction and field work.
  'I finished the site survey before the frost came in.',
  'We had to stop the pour when the concrete test failed.',
  'I have to run the levels again after any settlement.',
  // Research, marketing, HR.
  'I finished the fieldwork in twelve markets and the client signed it off.',
  'I have to run the campaign past legal before it goes live.',
  'I need to go back to the brief to answer that properly.',
  'I finished the restructure consultation and then wrote the new job families.',
  'I had to cancel the session with the client because the data was late.',
  'We had to end the call with the vendor and pick it up the next morning.',
  'Could we reschedule the workshop, I asked them, and they agreed.',
  // Habitual travel, which is a description of the job and not a goodbye. The
  // frequency is the whole difference: "I have to go to another meeting" is
  // somebody standing up, "I have to go to the office every day" is somebody
  // answering a question about where they work.
  'I have to go to the office every day.',
  'I have to go for training every quarter.',
  'I have to go to the client site every Tuesday to run the workshop.',
  'I have to go to site twice a week.',
  'I need to go to the depot each morning before the drivers leave.',
  // The indirect phrasings, used about the work rather than about leaving.
  "I don't think I can continue to justify the licence cost.",
  "I'm not able to do this in Excel at fifty markets.",
  "I don't think I can continue using that vendor after what happened.",
];

// The other direction, which matters exactly as much: a candidate who wants out
// must always be able to get out. Every tightening above is only safe if this
// list stays green, so it is pinned here beside the corpus it constrains rather
// than in a file somebody might tighten without reading.
const PLAIN_WITHDRAWALS = [
  "I'm done", "I'm done.", 'I am done.', "I'm finished", "I'm finished, thanks",
  "no, I'm done", 'done', 'I am done with this', "I'm done with this interview",
  "I'm done here", 'I want to stop', 'I would like to quit', 'can we stop here',
  "let's finish", 'end the interview please', 'stop the interview',
  // The words two real candidates used, both of which were talked over.
  "Well you know what I think I'm going to end the interview",
  "No I'm done I don't wanna do this to you anymore",
];

// Leaving, said with WHERE they are going.
//
// A first tightening of the leaving verbs closed the false-positive family
// above and closed this one with it, which is the worse trade of the two: a
// candidate who says "I have to go to another meeting" is standing up, and we
// carried on interviewing them. It is the commonest way an adult excuses
// themselves — more common than the bare "I have to go" that was all the
// tightened pattern still heard.
//
// The rule that separates these from the answers above is the one this file
// already turns on: a destination or a reason may follow the verb, an object of
// the verb may not. "Go to another meeting" is a destination. "Go back to 2019"
// is a verb with somewhere to be in the past.
const LEAVING_FOR_SOMEWHERE = [
  'I have to go to another meeting',
  'I need to leave for another call',
  'I have to go to a meeting',
  'I need to go to my next meeting',
  'I have to go to pick up my child',
  'I have to leave to pick up my kids',
  'I need to go for a doctor appointment',
  'I have to go for my next call',
  'I have to go to the school run',
  'I have to go to another meeting now',
];

// Leaving, said with WHY — and no comma to mark it, because speech-to-text
// supplies none and people type in a hurry when they are trying to leave.
const LEAVING_WITH_A_REASON = [
  'I need to go now my manager is calling',
  'I need to go now the client is waiting',
  'I have to go now, sorry',
  'I need to go right now',
  'I have to go, my manager is calling',
  'I have to go soon',
];

// Asking to stop without ever using the word.
//
// Indirect and hedged phrasing is how somebody who is struggling asks to leave
// — they soften it, because they are worried about the impression it makes.
// Neither engine heard any of this, so the people most likely to need the exit
// were the least likely to find it.
const INDIRECT_WITHDRAWALS = [
  "I don't think I can continue",
  "I don't think I can carry on",
  "I don't think I can continue with this",
  "I'm not able to do this anymore",
  "I'm not able to do this any more",
  'I am not able to continue',
  "I don't feel able to carry on",
];

// Ways of leaving that the intent engine, not the withdrawal detector, reads.
const PLAIN_ENDINGS = [
  ...PLAIN_WITHDRAWALS,
  ...LEAVING_FOR_SOMEWHERE,
  ...LEAVING_WITH_A_REASON,
  ...INDIRECT_WITHDRAWALS,
  'Stop', 'stop please', 'cancel', 'end this', "that's enough", "I'm out", 'I quit',
  'I need to go', 'I have to go', "I've got to go", 'I gotta go', 'I must go',
  'sorry, I have to go now', 'I have to leave', 'I need to leave', 'I have to jump off',
  "I can't continue", "I can't carry on", "I can't do this",
  'I have to go, my manager is calling',
  'stop, I need to go',
  // Asking for another time is also asking to stop now.
  'can we do this later', 'can we reschedule', "I'll do it later", "I'm not ready",
  'can we continue after class', "could we pick this up once my exams are over",
  'sorry, my manager just called, can we do this later?',
];

describe('describing work is not asking to leave', () => {
  it.each(DESCRIBING_WORK)('withdrawal detector ignores: %s', (text) => {
    expect(detectWithdrawal(text)).toBe(false);
  });

  it.each(DESCRIBING_WORK)('the interview survives: %s', (text) => {
    const reading = detectCandidateIntent(text);
    expect(ENDING_INTENTS.has(reading.intent), `read as ${reading.intent} by ${reading.rule}`).toBe(false);
  });
});

// This direction is not the mirror of the one above, it is the more important
// of the two, and it gets its own suite for that reason. A false stop costs an
// interview the candidate can ask to resume; a missed one locks somebody inside
// a conversation they have asked twice to leave. Any future tightening of the
// patterns has to come past here.
describe('a candidate who wants to stop is never trapped', () => {
  it.each(PLAIN_WITHDRAWALS)('withdrawal detector hears: %s', (text) => {
    expect(detectWithdrawal(text)).toBe(true);
  });

  it.each(INDIRECT_WITHDRAWALS)('withdrawal detector hears it said indirectly: %s', (text) => {
    expect(detectWithdrawal(text)).toBe(true);
  });

  it.each(PLAIN_ENDINGS)('the interview ends on: %s', (text) => {
    const reading = detectCandidateIntent(text);
    expect(ENDING_INTENTS.has(reading.intent), `read as ${reading.intent} by ${reading.rule}`).toBe(true);
  });
});
