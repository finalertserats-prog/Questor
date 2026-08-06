import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/engines/evaluator.js';
import type { Competency, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

function competency(id: string, name: string): Competency {
  return {
    id, name, definition: `Capability in ${name}`,
    category: 'technical', classification: 'essential', weight: 0.25,
    requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: ['behavioral_example'],
  };
}

const ASKED_A = competency('a', 'Asked A');
const ASKED_B = competency('b', 'Asked B');
const NEVER_ASKED = competency('c', 'Never Asked');

const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [],
  competencies: [ASKED_A, ASKED_B, NEVER_ASKED],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};

function turn(p: Partial<TurnRecord> & { speaker: TurnRecord['speaker']; text: string }): TurnRecord {
  return { id: Math.random().toString(36).slice(2), index: 0, startMs: 0, endMs: 1000, confidence: 1, ...p };
}

const TURNS: TurnRecord[] = [
  turn({ speaker: 'agent', index: 0, text: 'Tell me about Asked A.', competencyId: 'a' }),
  turn({
    speaker: 'candidate', index: 1, competencyId: 'a',
    text: 'When our nightly load failed I traced it to a schema change, I rebuilt the transform idempotently, and we cut failures by 60%.',
  }),
  turn({ speaker: 'agent', index: 2, text: 'Tell me about Asked B.', competencyId: 'b' }),
  turn({
    speaker: 'candidate', index: 3, competencyId: 'b',
    text: 'I designed the reporting model, I chose a star schema over one big table, and report latency went from 90 seconds to 8.',
  }),
];

describe('a competency nobody asked about', () => {
  /**
   * The unfairness this closes. A competency the interview had no time to reach
   * was scored as "no evidence gathered", counted against evidence coverage, and
   * coverage below 0.4 forces CONSIDER. The candidate was marked down for a
   * question nobody put to them.
   */
  it('is reported as not asked, not as a failure to demonstrate', async () => {
    const result = await evaluate({
      role: ROLE, turns: TURNS, rubricVersion: 'v1', assessmentVersion: 'A-1',
      notAssessed: ['Never Asked'],
    });
    const c = result.competencies.find((s) => s.name === 'Never Asked');
    expect(c).toBeTruthy();
    expect(c!.rationale.toLowerCase()).toMatch(/not asked|no time|not assessed/);
    expect(c!.rationale.toLowerCase()).not.toMatch(/no transcript evidence was gathered/);
  });

  it('does not count against evidence coverage', async () => {
    const withUnasked = await evaluate({
      role: ROLE, turns: TURNS, rubricVersion: 'v1', assessmentVersion: 'A-1',
      notAssessed: ['Never Asked'],
    });
    const asIfAsked = await evaluate({
      role: ROLE, turns: TURNS, rubricVersion: 'v1', assessmentVersion: 'A-2',
    });
    // Coverage measures the evidence yielded by what WAS asked. Excluding an
    // unasked competency can only raise it.
    expect(withUnasked.evidenceCoverage).toBeGreaterThan(asIfAsked.evidenceCoverage);
  });

  it('says plainly in the limitations that the interview did not cover everything', async () => {
    const result = await evaluate({
      role: ROLE, turns: TURNS, rubricVersion: 'v1', assessmentVersion: 'A-1',
      notAssessed: ['Never Asked'],
    });
    expect(result.limitations.join(' ')).toMatch(/Never Asked/);
  });

  it('still lowers confidence, because an incomplete interview knows less', async () => {
    // Excluding unasked competencies from coverage must not let a partial
    // interview present itself as a complete one.
    const partial = await evaluate({
      role: ROLE, turns: TURNS, rubricVersion: 'v1', assessmentVersion: 'A-1',
      notAssessed: ['Never Asked'],
    });
    const complete = await evaluate({
      role: { ...ROLE, competencies: [ASKED_A, ASKED_B] },
      turns: TURNS, rubricVersion: 'v1', assessmentVersion: 'A-2',
    });
    expect(partial.confidence).toBeLessThan(complete.confidence);
  });

  it('changes nothing when the interview covered every competency', async () => {
    const a = await evaluate({ role: ROLE, turns: TURNS, rubricVersion: 'v1', assessmentVersion: 'A-1', notAssessed: [] });
    const b = await evaluate({ role: ROLE, turns: TURNS, rubricVersion: 'v1', assessmentVersion: 'A-1' });
    expect(a.evidenceCoverage).toBe(b.evidenceCoverage);
    expect(a.limitations.length).toBe(b.limitations.length);
  });

  it('never marks an unasked competency as a must-pass failure', async () => {
    // Failing someone on a competency that was never raised would be the worst
    // version of this bug, not merely an unfair score.
    const role = { ...ROLE, scoringRules: { ...ROLE.scoringRules, mustPassCompetencyIds: ['c'] } };
    const result = await evaluate({
      role, turns: TURNS, rubricVersion: 'v1', assessmentVersion: 'A-1', notAssessed: ['Never Asked'],
    });
    expect(result.concerns.join(' ')).not.toMatch(/Never Asked is a must-pass competency but was demonstrated/);
  });
});
