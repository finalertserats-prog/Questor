import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Competency, RoleSuccessProfile, TurnRecord } from '../../src/domain/types.js';

/** The evaluator grades a library-planned block against the snapshot's anchors, and nothing else changes. */

const captured = vi.hoisted(() => ({ grader: [] as Array<{ system: string; user: string }> }));

vi.mock('../../src/providers/llm/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/llm/index.js')>();
  return {
    ...actual,
    generateJson: async (req: { system: string; user: string; fn: string; validate: (raw: unknown) => unknown }) => {
      if (req.fn !== 'competency_grader') return null;
      captured.grader.push({ system: req.system, user: req.user });
      return req.validate({ level: 4, confidence: 0.8, notEnoughEvidence: false, rationale: 'Specific and owned.' });
    },
  };
});

const { evaluate } = await import('../../src/engines/evaluator.js');

const C1: Competency = {
  id: 'c1', name: 'Incident Ownership', definition: 'Runs incidents.', category: 'behavioral', classification: 'essential',
  weight: 1, requiredLevel: 3, targetLevel: 4, indicators: [], evidenceModes: [],
};
const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [], competencies: [C1],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Senior',
};
const turns: TurnRecord[] = [
  { id: 'a', index: 0, speaker: 'agent', text: 'Take me to a failed settlement run.', startMs: 0, endMs: 1, confidence: 1, competencyId: 'c1', kind: 'question' },
  { id: 'b', index: 1, speaker: 'candidate', text: 'During the March outage I led the incident call and we reduced failed payouts by 40 percent.', startMs: 1, endMs: 2, confidence: 1, competencyId: 'c1' },
];

beforeEach(() => {
  captured.grader = [];
});

describe('evaluate with library anchors', () => {
  it('hands the grader the anchors of the question asked', async () => {
    await evaluate({ role: ROLE, turns, rubricVersion: 'sc', assessmentVersion: 'A1', anchors: { c1: ['Names who was told', 'Says what changed after'] } });
    expect(JSON.parse(captured.grader[0].user).strongAnswerCovers).toEqual(['Names who was told', 'Says what changed after']);
  });

  it('tells the grader the anchors are a checklist, not a script', async () => {
    await evaluate({ role: ROLE, turns, rubricVersion: 'sc', assessmentVersion: 'A1', anchors: { c1: ['Names who was told'] } });
    expect(captured.grader[0].system).toContain('never as a script the candidate had to recite');
  });

  it('sends exactly the old prompt when there are no anchors', async () => {
    await evaluate({ role: ROLE, turns, rubricVersion: 'sc', assessmentVersion: 'A1' });
    await evaluate({ role: ROLE, turns, rubricVersion: 'sc', assessmentVersion: 'A1', anchors: {} });
    expect(captured.grader[1]).toEqual(captured.grader[0]);
  });

  it('leaves the anchors out of the prompt when none were given', async () => {
    await evaluate({ role: ROLE, turns, rubricVersion: 'sc', assessmentVersion: 'A1' });
    expect(captured.grader[0].user + captured.grader[0].system).not.toContain('strongAnswerCovers');
  });
});
