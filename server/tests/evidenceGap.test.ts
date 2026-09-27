import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/engines/evaluator.js';
import { classifyEvidenceGap, evidenceGapRationale } from '../src/engines/evidenceGap.js';
import { detectCandidateIntent, isSubstantiveAnswer } from '../src/engines/candidateIntent.js';
import type { Competency, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

/**
 * Three different things were reaching a hiring manager as one sentence.
 *
 * "No transcript evidence was gathered for this competency during the
 * interview" was printed when nobody asked, when the candidate was asked and
 * said "I don't know", and when our own extraction dropped an answer they
 * gave. The first is our scheduling, the second is about them, the third is
 * our bug — and a reviewer deciding someone's career could not tell which had
 * happened. These tests pin each case to its own words.
 */

function competency(id: string, name: string): Competency {
  return {
    id, name, definition: `Capability in ${name}`,
    category: 'technical', classification: 'essential', weight: 0.25,
    requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: ['behavioral_example'],
  };
}

const ANSWERED = competency('a', 'Answered');
const DECLINED = competency('b', 'Declined');
const SILENT = competency('c', 'Silent');
const UNTOUCHED = competency('d', 'Untouched');

const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [],
  competencies: [ANSWERED, DECLINED, SILENT, UNTOUCHED],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};

let seq = 0;
function turn(p: Partial<TurnRecord> & { speaker: TurnRecord['speaker']; text: string }): TurnRecord {
  seq += 1;
  return { id: `t${seq}`, index: seq, startMs: seq * 1000, endMs: seq * 1000 + 900, confidence: 1, ...p };
}

/**
 * One transcript carrying all three shapes at once:
 *   a — asked and answered with a real story
 *   b — asked, and the candidate said they did not know
 *   c — asked, and nothing came back at all
 *   d — never raised
 */
function transcript(): TurnRecord[] {
  seq = 0;
  return [
    turn({ speaker: 'agent', text: 'Tell me about a time you owned a data pipeline.', competencyId: 'a' }),
    turn({
      speaker: 'candidate', competencyId: 'a',
      text: 'When our nightly load failed I traced it to a schema change, I rebuilt the transform idempotently, and we cut failures by 60%.',
    }),
    turn({ speaker: 'agent', text: 'How do you approach capacity planning?', competencyId: 'b' }),
    turn({ speaker: 'candidate', competencyId: 'b', text: "I don't know." }),
    turn({ speaker: 'agent', text: 'Tell me about a release you led.', competencyId: 'c' }),
  ];
}

async function assess(turns: TurnRecord[], notAssessed?: string[]) {
  const result = await evaluate({
    role: ROLE, turns, rubricVersion: 'v1', assessmentVersion: 'A-1', ...(notAssessed ? { notAssessed } : {}),
  });
  const by = (name: string) => {
    const found = result.competencies.find((s) => s.name === name);
    if (!found) throw new Error(`no competency scored for ${name}`);
    return found;
  };
  return { result, by };
}

describe('the three ways a competency can end up with no evidence', () => {
  it('says the candidate did not answer when they were asked and said they did not know', async () => {
    const { by } = await assess(transcript());

    expect(by('Declined').evidenceGap).toBe('declined');
    expect(by('Declined').rationale).toMatch(/did not answer/i);
  });

  it('never tells a reviewer a declined competency simply yielded no evidence', async () => {
    const { by } = await assess(transcript());

    expect(by('Declined').rationale).not.toMatch(/no transcript evidence was gathered/i);
  });

  it('says the question was put and nothing came back when the candidate never replied', async () => {
    const { by } = await assess(transcript());

    expect(by('Silent').evidenceGap).toBe('unanswered');
    expect(by('Silent').rationale).toMatch(/no answer/i);
    expect(by('Silent').rationale).not.toMatch(/no transcript evidence was gathered/i);
  });

  it('says nobody asked when no question on it was put', async () => {
    const { by } = await assess(transcript());

    expect(by('Untouched').evidenceGap).toBe('not_asked');
    expect(by('Untouched').rationale).toMatch(/no question .* was put|was not asked/i);
  });

  it('gives each of the three its own words, so a reviewer can tell them apart', async () => {
    const { by } = await assess(transcript());

    const said = [by('Declined').rationale, by('Silent').rationale, by('Untouched').rationale];
    expect(new Set(said).size).toBe(3);
  });

  it('blames our own pipeline, not the candidate, when an answer was given and nothing was extracted', () => {
    // Attribution files every answered turn under its question's competency, so
    // this cannot arise through `evaluate` today. It is the branch that has to
    // exist before attribution ever starts dropping spans: the wrong default is
    // to print the candidate's silence for our own miss.
    const turns = [
      turn({ speaker: 'agent', text: 'Tell me about a migration you ran.', competencyId: 'z' }),
      turn({
        speaker: 'candidate', competencyId: 'z',
        text: 'I ran the Postgres migration myself, cut over on a Saturday, and we lost no writes.',
      }),
    ];

    expect(classifyEvidenceGap({ turns, competencyId: 'z' })).toBe('not_extracted');
    expect(evidenceGapRationale('not_extracted')).toMatch(/our|system|pipeline/i);
    expect(evidenceGapRationale('not_extracted')).not.toMatch(/did not answer/i);
  });
});

describe('what counts as "did not answer"', () => {
  /**
   * The rule must be the one `candidateIntent` already owns. A second spelling
   * of "non-answer" that drifts from the first is a defect this codebase has
   * been bitten by more than once, so these cases are driven from the intent
   * reader itself rather than from a list written here.
   */
  const NON_ANSWERS = ["I don't know.", 'Not sure.', 'No idea.', "I can't remember.", 'Hmm.'];

  for (const text of NON_ANSWERS) {
    it(`treats ${JSON.stringify(text)} as a decline, exactly as candidateIntent reads it`, () => {
      // Guard on the premise: if candidateIntent stops calling this a
      // non-answer, this test must fail rather than quietly test nothing.
      expect(detectCandidateIntent(text).intent).toBe('non_answer');

      const turns = [
        turn({ speaker: 'agent', text: 'Tell me about capacity planning.', competencyId: 'z' }),
        turn({ speaker: 'candidate', competencyId: 'z', text }),
      ];
      expect(classifyEvidenceGap({ turns, competencyId: 'z' })).toBe('declined');
    });
  }

  it('does not call an answer a decline just because it opens with "I don\'t know"', () => {
    const text = "I don't know the exact number, but I rebuilt the ingestion job and failures dropped by more than half.";
    // The premise again: this IS an answer to candidateIntent, so a substring
    // rule of our own — the obvious wrong implementation — would be caught here.
    expect(isSubstantiveAnswer(text)).toBe(true);

    const turns = [
      turn({ speaker: 'agent', text: 'Tell me about capacity planning.', competencyId: 'z' }),
      turn({ speaker: 'candidate', competencyId: 'z', text }),
    ];
    expect(classifyEvidenceGap({ turns, competencyId: 'z' })).toBe('not_extracted');
  });

  it('is not a decline when the candidate only asked us to repeat the question', () => {
    const text = 'Sorry, could you say that again?';
    expect(detectCandidateIntent(text).intent).toBe('repeat');

    const turns = [
      turn({ speaker: 'agent', text: 'Tell me about capacity planning.', competencyId: 'z' }),
      turn({ speaker: 'candidate', competencyId: 'z', text }),
    ];
    expect(classifyEvidenceGap({ turns, competencyId: 'z' })).toBe('unanswered');
  });

  it('leaves a competency that did yield evidence with no gap recorded at all', async () => {
    // The field explains an absence. A competency with evidence has nothing to
    // explain, and a stray gap on it would put "nobody asked" beside a quote.
    const { by } = await assess(transcript());

    expect(by('Answered').evidenceGap).toBeUndefined();
    expect(by('Answered').notEnoughEvidence).toBe(false);
    expect(by('Answered').evidence.length).toBeGreaterThan(0);
  });
});

describe('the open questions a reviewer is handed', () => {
  it('distinguishes a competency they would not answer from one nobody raised', async () => {
    const { result } = await assess(transcript());

    const declined = result.openQuestions.find((q) => q.startsWith('Declined'));
    const untouched = result.openQuestions.find((q) => q.startsWith('Untouched'));
    expect(declined).toBeTruthy();
    expect(untouched).toBeTruthy();
    expect(declined).not.toBe(untouched);
    expect(declined).toMatch(/did not answer/i);
    expect(untouched).toMatch(/not asked|no question/i);
  });
});

describe('what must not move', () => {
  it('still marks every one of them not enough evidence, at the same confidence', async () => {
    const { by } = await assess(transcript());

    for (const name of ['Declined', 'Silent', 'Untouched']) {
      expect(by(name).notEnoughEvidence).toBe(true);
      expect(by(name).level).toBeNull();
      expect(by(name).confidence).toBe(0.2);
    }
  });

  it('still caps the recommendation when a must-pass competency was declined', async () => {
    const role = { ...ROLE, scoringRules: { ...ROLE.scoringRules, mustPassCompetencyIds: ['b'] } };
    const result = await evaluate({
      role, turns: transcript(), rubricVersion: 'v1', assessmentVersion: 'A-1',
    });

    expect(result.recommendation).toBe('CONSIDER');
    expect(result.limitations.join(' ')).toMatch(/Declined lacks sufficient evidence/);
  });

  it('leaves the arithmetic the recommendation is made of exactly where it was', async () => {
    const { result, by } = await assess(transcript());

    // One of four competencies yielded evidence. Naming the other three
    // honestly must not change any number the recommendation is computed from,
    // so each input is pinned rather than only the verdict they produce.
    expect(result.evidenceCoverage).toBe(0.25);
    // The single graded competency, and nothing else, sets the weighted mean.
    expect(result.overallScore).toBe(Math.round(((by('Answered').level as number) / 5) * 100));
    // Coverage below 0.4 is what forces this, and it still does.
    expect(result.recommendation).toBe('CONSIDER');
    expect(result.limitations.join(' ')).toMatch(/Sufficient-evidence coverage was 25%/);
  });

  it('does not invent a system-failure disclosure when nothing was mis-extracted', async () => {
    const { result } = await assess(transcript());

    expect(result.limitations.join(' ')).not.toMatch(/evidence extraction/i);
  });

  it('keeps the planned-but-unreached wording for a competency on the not-assessed list', async () => {
    const { by } = await assess(transcript(), ['Untouched']);

    expect(by('Untouched').rationale).toMatch(/did not have time/i);
    expect(by('Untouched').evidenceGap).toBe('not_asked');
  });
});
