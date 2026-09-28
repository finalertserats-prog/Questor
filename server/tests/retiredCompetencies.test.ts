import { describe, expect, it } from 'vitest';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { computeFitScore } from '../src/engines/fitScoring.js';
import { buildEvidenceFeedback } from '../src/services/feedbackContentModel.js';
import { retireCompetency } from '../src/domain/scorecardEdits.js';
import { roleSuccessProfileSchema } from '../src/domain/profileSchema.js';
import type { Competency, RoleSuccessProfile } from '../src/domain/types.js';

/**
 * A retired competency is history, not a current requirement: no new plan asks
 * about it and no resume is scored against it, yet an assessment made while it
 * was live still finds its name by id.
 */

function competency(id: string, name: string, weight: number): Competency {
  return {
    id, name, definition: `${name} as the role needs it`, category: 'technical', classification: 'essential', weight,
    requiredLevel: 2, targetLevel: 4, indicators: ['Shows it'], evidenceModes: ['behavioral_example'],
  };
}

const live: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [],
  competencies: [competency('sql1', 'SQL Modelling', 0.5), competency('py1', 'Python Pipelines', 0.5)],
  scoringRules: { mustPassCompetencyIds: ['sql1'], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};
const afterRetiring = retireCompetency(live, 'sql1');

describe('a retired competency', () => {
  it('gets no block in a new interview plan', () => {
    const plan = buildInterviewPlan({ role: afterRetiring, durationMinutes: 45 });

    expect(plan.blocks.map((b) => b.competencyId)).not.toContain('sql1');
  });

  it('is not listed as unassessed either, because it was not meant to be asked', () => {
    const plan = buildInterviewPlan({ role: afterRetiring, durationMinutes: 45 });

    expect(plan.notAssessed ?? []).not.toContain('SQL Modelling');
  });

  it('cannot be stored with weight, however the scorecard reaches the server', () => {
    const weighted = { ...live, competencies: live.competencies.map((c) => (c.id === 'sql1' ? { ...c, retired: true } : c)) };

    expect(roleSuccessProfileSchema.safeParse(weighted).success).toBe(false);
  });

  it('cannot stay must-pass', () => {
    const stillRequired = { ...afterRetiring, scoringRules: { ...afterRetiring.scoringRules, mustPassCompetencyIds: ['sql1'] } };

    expect(roleSuccessProfileSchema.safeParse(stillRequired).success).toBe(false);
  });

  it('is left out of the resume fit score', () => {
    const fit = computeFitScore({ employment: [], education: [], projects: [], certifications: [], skills: ['python'] }, 'Built Python pipelines.', afterRetiring);

    expect(fit.perCompetency.map((c) => c.competencyId)).not.toContain('sql1');
  });

  it('still lends its name and definition to a letter about an interview that assessed it', () => {
    const content = buildEvidenceFeedback({
      profile: afterRetiring,
      result: {
        assessmentVersion: 'v1', roleScorecardVersion: 'v1', recommendation: 'PROCEED', confidence: 0.8, evidenceCoverage: 1, overallScore: 80,
        competencies: [{ id: 'sql1', name: 'SQL Modelling', level: 4, requiredLevel: 2, confidence: 0.8, notEnoughEvidence: false, evidence: [{ turnId: 't', startMs: 0, endMs: 1, quote: 'I designed the star schema for the finance warehouse and cut the nightly load by half.' }], rationale: '', rubricVersion: 'v1' }],
        strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: '',
      },
    });

    expect(content.competencies[0]?.roleAsks).toContain('SQL Modelling');
  });
});
