import { describe, it, expect, vi } from 'vitest';
import type { Competency, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

/**
 * The one case the live pipeline cannot currently produce, driven through the
 * real evaluator anyway.
 *
 * Slot attribution files EVERY answered turn under its own question's
 * competency, unconditionally, so an answered competency always arrives at
 * `scoreCompetency` with at least one span — which is exactly why the
 * "we answered it and lost it" branch is untestable end-to-end without
 * standing in for the extractor. It is also exactly why the branch has to
 * exist: the day attribution starts filtering, the default it falls back to
 * decides whether a hiring manager reads our bug as the candidate's silence.
 *
 * Attribution is replaced here and nothing else is: the evaluator, the
 * classifier, the copy and the disclosure are all the real ones.
 */
vi.mock('../src/engines/evidenceExtractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engines/evidenceExtractor.js')>();
  return {
    ...actual,
    attributeEvidence: vi.fn(async () => ({ mode: 'slot' as const, modelExecutionId: '', byCompetency: {} })),
  };
});

const { evaluate } = await import('../src/engines/evaluator.js');

function competency(id: string, name: string): Competency {
  return {
    id, name, definition: `Capability in ${name}`,
    category: 'technical', classification: 'essential', weight: 0.5,
    requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: ['behavioral_example'],
  };
}

const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [],
  competencies: [competency('a', 'Pipelines'), competency('b', 'Releases')],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};

let seq = 0;
function turn(p: Partial<TurnRecord> & { speaker: TurnRecord['speaker']; text: string }): TurnRecord {
  seq += 1;
  return { id: `t${seq}`, index: seq, startMs: seq * 1000, endMs: seq * 1000 + 900, confidence: 1, ...p };
}

function transcript(): TurnRecord[] {
  seq = 0;
  return [
    turn({ speaker: 'agent', text: 'Tell me about a pipeline you owned.', competencyId: 'a' }),
    turn({
      speaker: 'candidate', competencyId: 'a',
      text: 'When our nightly load failed I traced it to a schema change, I rebuilt the transform idempotently, and we cut failures by 60%.',
    }),
    turn({ speaker: 'agent', text: 'Tell me about a release you led.', competencyId: 'b' }),
    turn({
      speaker: 'candidate', competencyId: 'b',
      text: 'I ran the Postgres cutover myself on a Saturday, wrote the rollback first, and we lost no writes.',
    }),
  ];
}

async function assess() {
  const result = await evaluate({ role: ROLE, turns: transcript(), rubricVersion: 'v1', assessmentVersion: 'A-1' });
  const by = (name: string) => {
    const found = result.competencies.find((s) => s.name === name);
    if (!found) throw new Error(`no competency scored for ${name}`);
    return found;
  };
  return { result, by };
}

describe('a competency the candidate answered and our extraction lost', () => {
  it('is recorded as our miss, not as an absent answer', async () => {
    const { by } = await assess();

    expect(by('Pipelines').evidenceGap).toBe('not_extracted');
    expect(by('Pipelines').rationale).toMatch(/did answer/i);
    expect(by('Pipelines').rationale).toMatch(/failure on our side/i);
  });

  it('never suggests the candidate declined or was not asked', async () => {
    const { by } = await assess();

    expect(by('Pipelines').rationale).not.toMatch(/did not answer|not asked|no question/i);
    expect(by('Pipelines').rationale).not.toMatch(/no transcript evidence was gathered/i);
  });

  it('is disclosed on the face of the assessment, like a grading failure', async () => {
    const { result } = await assess();

    const limitation = result.limitations.find((l) => /evidence extraction/i.test(l));
    expect(limitation).toBeTruthy();
    expect(limitation).toMatch(/2 competencies were answered/i);
    expect(limitation).toMatch(/Pipelines, Releases/);
    expect(limitation).toMatch(/not a finding about the candidate/i);
  });

  it('asks the reviewer to read the transcript rather than to re-ask the question', async () => {
    const { result } = await assess();

    const open = result.openQuestions.find((q) => q.startsWith('Pipelines'));
    expect(open).toMatch(/transcript needs a human read/i);
    expect(open).not.toMatch(/did not answer/i);
  });

  it('still leaves the score and the recommendation to the existing rules', async () => {
    const { result, by } = await assess();

    // Nothing was graded, but grading did not fail — the evidence never
    // arrived. That is Not Enough Evidence across the board, which is CONSIDER
    // by the coverage rule, NOT the SCORING_UNAVAILABLE that a grader outage
    // produces.
    expect(by('Pipelines').notEnoughEvidence).toBe(true);
    expect(by('Pipelines').gradingUnavailable).toBeUndefined();
    expect(result.evidenceCoverage).toBe(0);
    expect(result.overallScore).toBe(0);
    expect(result.recommendation).toBe('CONSIDER');
  });
});
