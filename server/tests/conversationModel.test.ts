import { describe, it, expect } from 'vitest';
import {
  acknowledgement,
  answerFromRoleFacts,
  answeredTurnIds,
  isAnswerInContext,
  isYesNoQuestion,
  currentSitting,
  isRepeatedTopic,
  nonAnswerStreak,
  pendingQuestion,
  premiseIsGrounded,
  salientPhrase,
  simplerQuestion,
  topicsOf,
} from '../src/engines/conversationModel.js';
import type { TurnRecord } from '../src/domain/types.js';

let n = 0;
function turn(speaker: TurnRecord['speaker'], text: string, competencyId = 'c1', kind?: string): TurnRecord {
  n += 1;
  return { id: `t${n}`, index: n, speaker, text, startMs: n, endMs: n + 1, confidence: 1, competencyId, ...(kind ? { kind } : {}) };
}

describe('pendingQuestion', () => {
  it('is the last question asked, not a pause or a re-ask of it', () => {
    const turns = [
      turn('agent', 'Walk me through how you QA a survey script.', 'c1', 'question'),
      turn('candidate', 'Pause'),
      turn('agent', "Of course — take your time. Just say 'ready' when you'd like to carry on.", 'c1', 'pause'),
      turn('candidate', 'ready'),
    ];
    expect(pendingQuestion(turns)?.text).toBe('Walk me through how you QA a survey script.');
  });

  it('is the question inside the opening, without the greeting', () => {
    const turns = [turn('agent', "Hi Jayesh, I'm Maya — thanks. Let's start — could you briefly tell me about your current role?", '__process__', 'opening')];
    expect(pendingQuestion(turns)?.text).toBe('Could you briefly tell me about your current role?');
  });
});

describe('nonAnswerStreak', () => {
  it('counts the non-answers given to the pending question, ignoring pauses', () => {
    const turns = [
      turn('agent', 'Walk me through how you QA a survey script.', 'c1', 'question'),
      turn('candidate', 'Oh'),
      turn('agent', 'No problem — let me put it more simply: …', 'c1', 'rephrase'),
      turn('candidate', 'Pause'),
      turn('agent', 'Of course — take your time.', 'c1', 'pause'),
      turn('candidate', 'Nothing'),
    ];
    expect(nonAnswerStreak(turns)).toBe(2);
  });

  it('resets once a real answer arrives', () => {
    const turns = [
      turn('agent', 'Walk me through how you QA a survey script.', 'c1', 'question'),
      turn('candidate', 'No'),
      turn('agent', 'Let me put it more simply', 'c1', 'rephrase'),
      turn('candidate', 'I test every skip pattern in a staging link before fieldwork.'),
    ];
    expect(nonAnswerStreak(turns)).toBe(0);
  });
});

describe('simplerQuestion', () => {
  it('rephrases a competency question in plainer words about that competency', () => {
    const q = simplerQuestion('In Survey Programming, when have you had to choose between two defensible options?', 'Survey Programming', 0);
    expect(q).toMatch(/survey programming/i);
    expect(q).not.toBe('In Survey Programming, when have you had to choose between two defensible options?');
  });

  it('keeps the warm-up simple too', () => {
    expect(simplerQuestion('Could you briefly tell me about your current role?', 'Process & Consent', 0, '__process__')).toMatch(/current (job|role)/i);
  });
});

describe('salientPhrase and acknowledgement', () => {
  it('picks a named tool the candidate mentioned', () => {
    expect(salientPhrase('Mostly I script trackers in Decipher and hand them to the data team.')).toBe('Decipher');
  });

  it('picks the thing they said they did', () => {
    expect(salientPhrase('I managed the migration of our tracker questionnaires last year.')).toMatch(/migration of our tracker questionnaires/);
  });

  it('acknowledges using only words the candidate said', () => {
    const answer = 'Mostly I script trackers in Decipher and hand them to the data team.';
    const ack = acknowledgement(answer, 0);
    expect(ack).toContain('Decipher');
  });

  it('never praises or grades the answer', () => {
    for (let seed = 0; seed < 8; seed++) {
      const ack = acknowledgement('I managed the migration of our tracker questionnaires last year.', seed);
      expect(ack).not.toMatch(/great|excellent|perfect|impressive|fantastic|brilliant|well done|good answer/i);
    }
  });

  it('says nothing for a non-answer', () => {
    expect(acknowledgement('Oh', 0)).toBe('');
  });

  it('does not repeat the acknowledgement it just used', () => {
    const answer = 'I managed the migration of our tracker questionnaires last year.';
    const first = acknowledgement(answer, 0);
    expect(acknowledgement(answer, 0, first)).not.toBe(first);
  });
});

describe('isRepeatedTopic', () => {
  // Session B asked "build versus buy" about five times, in five wordings.
  const BUILD_VS_BUY = [
    'How do you decide between building a custom solution and buying an off-the-shelf survey tool?',
    'Tell me about a build versus buy decision you made on a survey platform.',
    'When have you had to choose between developing something in-house and using a vendor platform?',
    'What factors do you weigh in a build-vs-buy call for survey tooling?',
    'Walk me through how you evaluated whether to buy a third-party tool or build your own.',
  ];

  it('recognises every wording as the same topic', () => {
    for (const q of BUILD_VS_BUY) expect(topicsOf(q), q).toContain('build_vs_buy');
  });

  it('refuses each later variant once the first was asked', () => {
    for (const q of BUILD_VS_BUY.slice(1)) expect(isRepeatedTopic(q, [BUILD_VS_BUY[0]]), q).toBe(true);
  });

  it('refuses a second question about long-term consequences', () => {
    expect(isRepeatedTopic(
      'What were the long-term consequences of that choice for the team?',
      ['Looking back, what long-term impact did that decision have?'],
    )).toBe(true);
  });

  it('allows a genuinely different question', () => {
    expect(isRepeatedTopic(
      'How do you QA a questionnaire before it goes to field?',
      BUILD_VS_BUY,
    )).toBe(false);
  });

  it('refuses a near-verbatim re-ask', () => {
    expect(isRepeatedTopic(
      'Tell me about a time you had to manage a survey project timeline with a difficult client.',
      ['Tell me about a time you managed a survey project timeline with a difficult client.'],
    )).toBe(true);
  });
});

describe('premiseIsGrounded', () => {
  const said = ['I coordinate with the research managers; they decide whether we build custom solutions.'];

  it('accepts "you mentioned" when the candidate did say it', () => {
    expect(premiseIsGrounded('You mentioned the research managers decide on custom solutions — how do you support that call?', said)).toBe(true);
  });

  it('rejects "you mentioned" when the candidate never said it', () => {
    expect(premiseIsGrounded('You mentioned leading the platform architecture migration — what were the long-term consequences?', said)).toBe(false);
  });

  it('accepts a question with no premise at all', () => {
    expect(premiseIsGrounded('How do you QA a questionnaire before launch?', said)).toBe(true);
  });
});

describe('answerFromRoleFacts', () => {
  const facts = {
    title: 'Project Manager - Survey Delivery',
    responsibilities: ['Manage end-to-end delivery of online survey projects', 'Coordinate timelines with research managers and clients'],
    focus: ['Project Management', 'Survey Programming', 'Technical Proficiency in Survey Tools'],
    durationMinutes: 30,
  };

  it('answers "what role is this" from the job description', () => {
    const a = answerFromRoleFacts("what exact role are you looking for, because a few questions asked about taking decisions on custom solutions, this is usually the research manager's call", facts);
    expect(a).toMatch(/Project Manager/);
    expect(a).toMatch(/delivery of online survey projects/i);
    expect(a).toMatch(/hiring team/i);
  });

  it('answers a process question with what actually happens next', () => {
    expect(answerFromRoleFacts('what are the next steps?', facts)).toMatch(/hiring team/i);
  });

  it('does not invent facts it does not have', () => {
    const a = answerFromRoleFacts('what is the salary for this role?', facts);
    expect(a).toMatch(/hiring team/i);
    expect(a).not.toMatch(/\d/);
  });
});

describe('isYesNoQuestion', () => {
  it.each([
    ['Did you personally write the survey scripts?', true],
    ['Have you used Qualtrics for a tracker?', true],
    ['Is that something you would do differently now?', true],
    ['Can you walk me through how you QA a script?', false],
    ['Can you set the scene a bit more — what was the context, and what constraints were you working under?', false],
    ['Tell me about a time Survey Programming was the difference between a project going well and going badly. What did you personally do?', false],
    ['How do you decide which platform to script in?', false],
    // Asks for an account, however it opens — a bare "Yes" answers none of these.
    ['Is there an example you can share?', false],
    ['Were you the owner? Tell me what happened.', false],
    ['Did you script it yourself? Walk me through how.', false],
    ['Can you give me an example of that?', false],
    ['Have you got a story about a wave that went wrong?', false],
    ['Would you describe how that decision was made?', false],
    // …and the genuine yes/no question still is one, including when its own
    // predicate happens to contain a word the account-request list uses.
    ['Did you personally write the survey scripts?', true],
    ['Were you the owner of that tracker?', true],
    ['Did you share the tracker with the client?', true],
    ['Did you give the client the QA report?', true],
    ['Can you share an example?', false],
    ['Could you share a time that went wrong?', false],
    // An auxiliary opening whose object is the account itself: "Yes" answers none.
    ['Do you have a recent project you can walk me through?', false],
    ['Have you got an example of that?', false],
    ['Is there a project you could tell me about?', false],
    ['Do you have a case where that went wrong?', false],
  ])('"%s" -> %s', (question, expected) => {
    expect(isYesNoQuestion(question)).toBe(expected);
  });
});

describe('a bare yes or no', () => {
  const question = (text: string) => turn('agent', text, 'c1', 'question');

  it('is an answer when the question was a yes/no question', () => {
    const turns = [question('Did you personally write the survey scripts?'), turn('candidate', 'Yes.')];
    expect(isAnswerInContext(turns, 1)).toBe(true);
    expect(answeredTurnIds(turns).has(turns[1].id)).toBe(true);
  });

  it('is still nothing when the question was open', () => {
    const turns = [question('Walk me through how you QA a survey script.'), turn('candidate', 'Yes.')];
    expect(isAnswerInContext(turns, 1)).toBe(false);
    expect(answeredTurnIds(turns).has(turns[1].id)).toBe(false);
  });

  it('leaves "Oh" and "Welcome back" as nothing, whatever was asked', () => {
    const turns = [question('Did you personally write the survey scripts?'), turn('candidate', 'Oh'), turn('candidate', 'Welcome back')];
    expect(isAnswerInContext(turns, 1)).toBe(false);
    expect(isAnswerInContext(turns, 2)).toBe(false);
  });
});

describe('currentSitting', () => {
  it('starts after a closed postponement, so a rescheduled interview begins again', () => {
    const turns = [
      turn('agent', 'Hi — let us start.', '__process__', 'opening'),
      turn('candidate', 'can we do this later'),
      { ...turn('agent', 'Of course — we can do this another time.', '__process__', 'postponed'), sittingClosed: true },
      turn('agent', 'Hi again.', '__process__', 'opening'),
    ];
    expect(currentSitting(turns).map((t) => t.text)).toEqual(['Hi again.']);
  });

  it('keeps a postponement that has not been re-invited after, so nothing is asked past it', () => {
    const turns = [
      turn('agent', 'Hi — let us start.', '__process__', 'opening'),
      turn('candidate', 'can we do this later'),
      turn('agent', 'Of course — we can do this another time.', '__process__', 'postponed'),
    ];
    expect(currentSitting(turns).map((t) => t.kind)).toEqual(['opening', undefined, 'postponed']);
  });
});
