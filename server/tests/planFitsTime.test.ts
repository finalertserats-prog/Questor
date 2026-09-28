import { describe, it, expect } from 'vitest';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { extractRoleHeuristic } from '../src/engines/roleIntelligence.js';
import { DEMO_JD } from '../src/seed/demoData.js';
import type { Competency, RoleSuccessProfile } from '../src/domain/types.js';

function competency(i: number, weight: number): Competency {
  return {
    id: `c${i}`, name: `Competency ${i}`, definition: 'x',
    category: 'technical', classification: 'essential', weight,
    requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: ['behavioral_example'],
  };
}

function roleWith(n: number): RoleSuccessProfile {
  const competencies = Array.from({ length: n }, (_, i) => competency(i, 1 / n));
  return {
    roleContext: '', outcomes: [], responsibilities: [], competencies,
    scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
    redFlags: [], seniority: 'Mid',
  };
}

const sumMinutes = (blocks: Array<{ targetMinutes: number }>) =>
  blocks.reduce((a, b) => a + b.targetMinutes, 0);

describe('a plan fits the time it has', () => {
  /**
   * The defect this exists to prevent. A 12-minute interview was planned with 34
   * minutes of blocks — seven competencies each given a hard 3-minute floor plus
   * 13 minutes of fixed overhead. The director ran out of time and closed,
   * leaving three blocks unasked, and the assessment then reported those
   * competencies as lacking evidence: the candidate marked down for questions
   * nobody put to them.
   */
  it('never commits more minutes than the interview has', () => {
    for (const durationMinutes of [12, 15, 20, 30, 45, 60]) {
      for (const n of [1, 3, 5, 7, 10, 12]) {
        const plan = buildInterviewPlan({ role: roleWith(n), durationMinutes });
        expect(sumMinutes(plan.blocks), `${durationMinutes}min / ${n} competencies`)
          .toBeLessThanOrEqual(durationMinutes);
      }
    }
  });

  it('keeps the process, warmup and close blocks whatever the pressure', () => {
    const plan = buildInterviewPlan({ role: roleWith(12), durationMinutes: 12 });
    for (const id of ['__process__', '__warmup__', '__candidate_questions__']) {
      expect(plan.blocks.find((b) => b.competencyId === id), id).toBeTruthy();
    }
  });

  it('records the competencies it could not fit, rather than dropping them silently', () => {
    const plan = buildInterviewPlan({ role: roleWith(10), durationMinutes: 15 });
    expect(plan.notAssessed?.length).toBeGreaterThan(0);
    // Everything is accounted for: either planned or explicitly named as unfitted.
    const planned = plan.blocks.filter((b) => !b.competencyId.startsWith('__')).length;
    expect(planned + (plan.notAssessed?.length ?? 0)).toBe(10);
  });

  it('drops the lowest-weight competencies first, keeping what matters most', () => {
    const competencies = [
      { ...competency(0, 0.5), name: 'Most important' },
      { ...competency(1, 0.3), name: 'Middling' },
      { ...competency(2, 0.1), name: 'Least important A' },
      { ...competency(3, 0.1), name: 'Least important B' },
    ];
    const role = { ...roleWith(1), competencies };
    const plan = buildInterviewPlan({ role, durationMinutes: 20 });
    const kept = plan.blocks.filter((b) => !b.competencyId.startsWith('__')).map((b) => b.competencyName);
    expect(kept).toContain('Most important');
    if (plan.notAssessed?.length) {
      expect(plan.notAssessed.join(' ')).not.toContain('Most important');
    }
  });

  it('assesses at least one competency even in an implausibly short slot', () => {
    const plan = buildInterviewPlan({ role: roleWith(12), durationMinutes: 10 });
    expect(plan.blocks.filter((b) => !b.competencyId.startsWith('__')).length).toBeGreaterThanOrEqual(1);
  });

  it('leaves a normal 45-minute interview alone', () => {
    // The fix must not shrink interviews that already fit — the real deployment
    // runs at 45 minutes and was never affected by this.
    const role = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer').profile;
    const plan = buildInterviewPlan({ role, durationMinutes: 45 });
    expect(plan.notAssessed ?? []).toHaveLength(0);
    const scored = role.competencies.filter((c) => c.classification !== 'non_scoring').length;
    expect(plan.blocks.filter((b) => !b.competencyId.startsWith('__'))).toHaveLength(scored);
  });

  it('still gives every planned competency enough time to be worth asking', () => {
    const plan = buildInterviewPlan({ role: roleWith(10), durationMinutes: 30 });
    for (const b of plan.blocks.filter((x) => !x.competencyId.startsWith('__'))) {
      expect(b.targetMinutes, b.competencyName).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps resume validation when there is room for it', () => {
    const plan = buildInterviewPlan({ role: roleWith(3), durationMinutes: 45 });
    expect(plan.blocks.find((b) => b.competencyId === '__resume_validation__')).toBeTruthy();
  });
});
