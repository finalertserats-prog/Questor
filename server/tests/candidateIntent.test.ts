import { describe, it, expect } from 'vitest';
import { detectCandidateIntent, isSubstantiveAnswer, llmIntentSchema, mergeLlmIntent, type CandidateIntent } from '../src/engines/candidateIntent.js';

// What the candidate MEANT, read before the interviewer chooses what to say.
//
// Two production transcripts drove this table. In one, a candidate asked three
// times to do the interview later and then typed "Stop" — and was handed a work
// sample. In the other, "Oh", "No", "Pause", "Nothing" and "Welcome back" were
// each treated as an answer and followed up. Every phrase from those two
// sessions is pinned here, alongside the typed and speech-to-text variants of
// the same intent and the job talk that must NOT trip it.

const table = (intent: CandidateIntent, phrases: string[]) =>
  phrases.map((p) => [p, intent] as const);

const STOP = table('stop', [
  // Session A, typed.
  'Stop',
  'stop', 'stop.', 'STOP', 'Stop!', ' stop ', 'stop please', 'please stop', 'Please stop.',
  'stop stop', 'stop, stop', 'ok stop', 'okay stop', 'no stop', 'no, stop', 'just stop',
  'I want to stop this', 'I want to stop', 'i wanna stop', 'I would like to stop now',
  'cancel', 'Cancel.', 'can we cancel', 'can we cancel this', 'please cancel the interview',
  'end this', 'end it', 'end the interview', 'end the interview please', "let's end this",
  'I quit', "I'm done", 'im done', "I'm finished", 'I am done with this',
  'stop the interview', 'can we stop here', "I don't want to do this", "I don't want",
  "i dont want", 'I do not want to continue', "that's enough", 'enough', 'exit', 'leave',
  // The phrasing a real candidate used in an earlier incident.
  "Well you know what I think I'm going to end the interview",
  "No I'm done I don't wanna do this to you anymore",
]);

const POSTPONE = table('postpone', [
  // Session A.
  'Now can we have this interview later',
  "I don't want to take the interview right now can you cancel it we can have it sometime later",
  // Variants.
  'can we do this later', 'Can we do this later?', 'can we do it another time', 'later', 'maybe later',
  'another time', 'not now', 'not right now', 'Not today.', 'can we reschedule', 'I need to reschedule',
  'please reschedule', 'could we postpone this', "let's do it tomorrow", "let's do this tomorrow",
  'can we do this next week', "I'm not ready", 'i am not ready for this', "I can't do this right now",
  "I don't want to do the interview today", 'can we have it some other time', 'some other day please',
]);

const PAUSE = table('pause', [
  // Session B.
  'Pause',
  'pause', 'pause.', 'pause please', 'can we pause', 'wait', 'wait.', 'wait a second', 'hold on',
  'hold on a sec', 'hang on', 'one second', 'one sec', 'just a minute', 'give me a minute',
  'give me a moment please', 'can I have a minute', 'I need a minute', 'can we take a short break',
  'sorry one moment', 'let me think',
]);

const NON_ANSWER = table('non_answer', [
  // Session B.
  'Oh', 'No', 'Nothing', 'Welcome back',
  // Variants.
  'oh.', 'no.', 'nope', 'nothing really', 'none', 'hmm', 'hm', 'um', 'uh', 'ok', 'okay', 'yes', 'yeah',
  "I don't know", 'i dont know', 'idk', 'no idea', 'not sure', "I'm not sure", 'hello', 'hi',
  'can you hear me', 'are you there', 'thank you', '', '   ', '...',
]);

const SKIP = table('skip', [
  'skip', 'pass', 'next', 'next question', 'move on', "let's move on", 'can we move on', 'skip this one',
  "I'd rather not answer that", "I don't want to answer that",
]);

const RESUME = table('resume', [
  'ready', "I'm ready", 'ok ready', "I'm back", "let's continue", 'continue', 'go ahead', 'carry on',
]);

const REPEAT = table('repeat', [
  'can you repeat that', 'could you say that again', 'what was the question', 'pardon', 'come again',
  'rephrase', 'can you rephrase', "I didn't understand the question", 'what do you mean',
  "I don't understand", 'Sorry?', 'sorry',
]);

const CORRECTION = table('correction', [
  // Session B.
  "I think you got it wrong, I didn't say that",
  "that's not what I said", 'you misunderstood me', 'I never said that', 'no, you misheard me',
  "that's not what I meant, I said we used Decipher",
]);

const QUESTION = table('question', [
  // Session B, at the close.
  "what exact role are you looking for, because a few questions asked about taking decisions on custom solutions, this is usually the research manager's call",
  'what does this role involve day to day?', 'can I ask who I would report to', 'what are the next steps?',
  'is this role remote?', 'how big is the team?',
]);

// The stop patterns must not fire on a candidate describing work they want to
// change. "I need to stop using Excel" ends a real interview unscored, and with
// no credits on the model account the deterministic path is the only path.
const WORK_TALK_NOT_STOP = table('answer', [
  'I need to stop using Excel for tracker delivery',
  'I think I should continue to use Decipher',
  'I might stop using Excel for the tracker',
  'maybe we should wrap up the fieldwork early',
  'I would like to stop relying on vendors',
  'I want to end the manual process',
  'I want to stop doing the checks by hand every morning',
  'I wanna stop wasting a day on every quota change',
  "I'm going to stop using Decipher for the short pulse work",
  'We want to end that practice before the next wave',
  "Let's stop guessing and put a proper QA step in",
  'Can we stop duplicate records being created at source?',
  "I don't want to do manual reconciliation for every market",
  'I would like to quit the spreadsheet habit entirely',
]);

// Asking for another time, in the words people actually use. Each of these was
// reaching only the model; with no model the interviewer asked its next
// question — the exact production failure.
const POSTPONE_DETERMINISTIC = table('postpone', [
  "I'll do it later",
  'I will do it later',
  'I can come back after exams',
  'can I come back later',
  'could we pick this up once my exams are over',
  'can we pick this up another day',
  'can I do this tomorrow',
  "let's continue another day",
  "I'm not free right now, later?",
  "I'm not free at the moment",
  'can we reschedule',
  'could we do it after my shift',
  'can we continue after class',
  'I can do this when I am free',
  'can we pick this up after work',
  // Asked politely, with the filler people put in front of it.
  "honestly I'd prefer we pick this up once my exams are over",
  "I'd prefer we continue tomorrow",
  "I'd like to continue tomorrow",
  "I'd like to pick this up after class",
  'to be honest I would rather we continue another day',
  "sorry, could we do this later please",
  'can we continue tomorrow if that works',
  // With the reason people give, before or after the request.
  'sorry, my manager just called, can we do this later?',
  'can we do this later because my manager just called',
  'my kid just woke up, can we continue tomorrow?',
  "can we pick this up tomorrow, I'm on a client call",
  'can we do this another time, my exam starts in 10 minutes',
  "I'd like to pick this up tomorrow since something came up at home",
]);

// A bare stop, then the reason for it. The stop word opens the message, so it
// is not the verb of a sentence about work.
const STOP_WITH_REASON = table('stop', [
  'stop, I need to go',
  'stop, I have to leave',
  'stop please, something came up',
  'sorry, stop — I need to go',
  'stop, my next meeting is starting',
  "stop, I can't do this",
]);

// The same words inside a sentence about the work. A postponement is the
// candidate asking, now, for another time — not a plan for a pipeline and not
// something a client once asked for.
const WORK_TALK_NOT_POSTPONE = table('answer', [
  "I'll do it later in the pipeline",
  'the client asked if we could pick this up after work',
  'we rescheduled the fieldwork',
  "I'll pick this up after the holidays with the client",
  'later in the pipeline we add a QA step',
  'the team wanted to continue after the weekend, so we replanned the wave',
  "I'd like to continue working on that tracker later this year",
  // The stop word as an ordinary verb, with an object: still work talk.
  'we had to stop the project because the client changed the brief',
  'I need to stop using Excel because it falls over at 50 markets',
  'stop the survey when the quota for that cell is full',
]);

const ANSWER = table('answer', [
  // Must NOT end, pause or skip anything: this is job talk.
  'We had to stop the project when the client changed the brief.',
  'The survey stops when the quota for that cell is full.',
  "I don't want to overpromise to clients, so I give conservative timelines.",
  'Later we moved to Qualtrics because Decipher licensing got expensive.',
  'We decided to stop the rollout after the incident',
  'The team wanted to end that project early',
  'I helped them finish the migration ahead of schedule',
  'My job was to stop duplicate records being created',
  'I had to cancel the fieldwork and reschedule it for the following week with the vendor.',
  'We paused the survey for a day while the logic was fixed, then relaunched.',
  'No, in that project I owned the questionnaire programming end to end in Decipher.',
  'Nothing broke in production, because I tested every skip pattern before launch.',
  'I manage survey delivery for three research teams, from scripting to data checks.',
  'I think the hardest part was getting the quotas right across twelve markets.',
  'When I joined the team, the survey scripts had no version control at all.',
  'Could I explain the later stages first? The fieldwork is where it got interesting, with the vendor.',
]);

describe('detectCandidateIntent', () => {
  it.each([...STOP, ...POSTPONE, ...POSTPONE_DETERMINISTIC, ...PAUSE, ...NON_ANSWER, ...SKIP, ...RESUME, ...REPEAT, ...CORRECTION, ...QUESTION, ...ANSWER, ...WORK_TALK_NOT_STOP, ...WORK_TALK_NOT_POSTPONE, ...STOP_WITH_REASON])(
    '"%s" reads as %s',
    (text, intent) => {
      expect(detectCandidateIntent(text).intent).toBe(intent);
    },
  );

  it('keeps distress as its own intent so the safety path still runs', () => {
    expect(detectCandidateIntent('I think this is a medical emergency').intent).toBe('distress');
  });

  it('flags a question about whether the interviewer is an AI, asked on its own', () => {
    expect(detectCandidateIntent('Are you an AI?').intent).toBe('ai_identity');
  });
});

describe('isSubstantiveAnswer', () => {
  it.each([
    ['Oh', false], ['No', false], ['Pause', false], ['Stop', false], ['can we do this later', false],
    ['what was the question', false], ['I manage survey delivery for three research teams.', true],
  ])('"%s" -> %s', (text, expected) => {
    expect(isSubstantiveAnswer(text)).toBe(expected);
  });
});

// Three tiers, because two were never enough: tightening the patterns missed
// real requests, loosening them ended real interviews. Now an utterance either
// clearly ends the interview, clearly carries on with the work, or — the new
// middle — carries a cue the interviewer is not sure about, and asks.
type Tier = 'end-stop' | 'end-postpone' | 'continue' | 'confirm-stop' | 'confirm-postpone';

function tier(text: string): Tier {
  const reading = detectCandidateIntent(text);
  if (reading.unclear) return `confirm-${reading.unclear}` as Tier;
  if (reading.intent === 'stop') return 'end-stop';
  if (reading.intent === 'postpone') return 'end-postpone';
  return 'continue';
}

const tiers = (t: Tier, phrases: string[]) => phrases.map((p) => [p, t] as const);

const CLEAR_END = tiers('end-stop', [
  // Everything the earlier rounds pinned, plus the ways people say they must go.
  'Stop', 'stop please', 'cancel', 'end this', 'stop the interview', 'end the interview please',
  'stop, I need to go', 'stop please, something came up', "I'm done", 'I want to stop',
  'I need to go', 'I have to go', "I've got to go", 'I gotta go', 'sorry, I have to go now',
  'I have to leave', 'I have to leave now', 'I need to leave', 'I must go', 'really, I have to go',
  "I can't continue", "I can't carry on", "I can't do this", 'I have to jump off',
  'sorry I need to go now',
]);

const CLEAR_END_POSTPONE = tiers('end-postpone', [
  'can we do this later', 'Now can we have this interview later', 'can we reschedule',
  "I'll do it later", 'I can come back after exams', "let's continue another day",
  'sorry, my manager just called, can we do this later?', 'not right now', "I'm not ready",
  "I can't do this right now",
]);

const CLEAR_CONTINUE = tiers('continue', [
  // The ending word is a verb with an object, mid-sentence.
  'stop it because the quota is full, then reopen the cell',
  'We had to stop the project when the client changed the brief.',
  'I need to stop using Excel for tracker delivery',
  'I think I should continue to use Decipher',
  'I might stop using Excel for the tracker',
  'maybe we should wrap up the fieldwork early',
  'I want to end the manual process',
  'The survey stops when the quota for that cell is full.',
  'My job was to stop duplicate records being created',
  // Reported speech, whoever is reporting it.
  'I asked the client, can we do this later because the data was late',
  'the client asked if we could pick this up after work',
  'the team wanted to continue after the weekend, so we replanned the wave',
  // The cue is part of a phrase about the work.
  "I'll do it later in the pipeline",
  "I'll pick this up after the holidays with the client",
  'later in the pipeline we add a QA step',
  'Later we moved to Qualtrics because Decipher licensing got expensive.',
  // Ordinary answers with no cue at all.
  'I manage survey delivery for three research teams, from scripting to data checks.',
  'No, in that project I owned the questionnaire programming end to end in Decipher.',
]);

const AMBIGUOUS = [
  ...tiers('confirm-stop', [
    'I might have to stop soon',
    'I may need to wrap this up',
    "I'm not sure I can keep going",
    'I think I should probably stop',
  ]),
  ...tiers('confirm-postpone', [
    'maybe another time would be better',
    "tomorrow might be easier for me",
    'I wonder if later would work',
  ]),
];

describe('the three tiers', () => {
  it.each([...CLEAR_END, ...CLEAR_END_POSTPONE, ...CLEAR_CONTINUE, ...AMBIGUOUS])(
    '"%s" is %s',
    (text, expected) => {
      expect(tier(text)).toBe(expected);
    },
  );

  it('never marks a clear ending as unclear', () => {
    for (const [text] of CLEAR_END) expect(detectCandidateIntent(text).unclear, text).toBeUndefined();
  });

  it('leaves a long answer that happens to contain a cue alone', () => {
    const long = 'We stop the wave when the quota fills, and later in the field period we reopen the cells that are short, which means the client gets a clean read on every market without us going back for another sample.';
    expect(tier(long)).toBe('continue');
  });
});

describe('mergeLlmIntent — the model may only add safety', () => {
  const read = (text: string) => detectCandidateIntent(text);

  it('never turns a deterministic stop into anything else', () => {
    expect(mergeLlmIntent(read('Stop'), { intent: 'answer', confidence: 0.99 }).intent).toBe('stop');
  });

  it('never turns a deterministic postponement into an answer', () => {
    expect(mergeLlmIntent(read('can we do this later'), { intent: 'answer', confidence: 0.99 }).intent).toBe('postpone');
  });

  it('adds a stop the patterns missed, when confident', () => {
    expect(mergeLlmIntent(read("honestly I'm out of here, this isn't for me"), { intent: 'stop', confidence: 0.9 }).intent).toBe('stop');
  });

  it('ignores an unconfident reading', () => {
    expect(mergeLlmIntent(read('We rebuilt the quota logic.'), { intent: 'stop', confidence: 0.5 }).intent).toBe('answer');
  });

  it('cannot turn a real answer into a pause', () => {
    expect(mergeLlmIntent(read('We rebuilt the quota logic.'), { intent: 'pause', confidence: 0.95 }).intent).toBe('answer');
  });

  it('ignores a failed or missing model reading', () => {
    expect(mergeLlmIntent(read('We rebuilt the quota logic.'), null).intent).toBe('answer');
  });

  it('rejects a reply outside the strict schema', () => {
    expect(llmIntentSchema.safeParse({ intent: 'stop', confidence: 0.9, reason: 'x' }).success).toBe(false);
    expect(llmIntentSchema.safeParse({ intent: 'quit', confidence: 0.9 }).success).toBe(false);
  });
});
