import type { Competency, FitScore, InterviewPlan, PlanBlock, RoleSuccessProfile } from '../domain/types.js';
import { isWorkSampleEligible } from './workSample.js';

// Interview plan builder (BRD FR-016, Appendix 25.1). Produces comparable
// competency coverage while reserving process, warmup, resume-validation and
// candidate-question blocks. Time is allocated by competency weight.

export function buildInterviewPlan(opts: {
  role: RoleSuccessProfile;
  fit?: FitScore;
  durationMinutes?: number;
  language?: string;
  modules?: string[];
}): InterviewPlan {
  const durationMinutes = opts.durationMinutes ?? 45;
  const language = opts.language ?? 'en';
  const modules = opts.modules ?? [];
  const scored = opts.role.competencies.filter((c) => c.classification !== 'non_scoring');

  // Fixed overhead blocks.
  const processMin = 3;
  const warmupMin = 4;
  const candidateQMin = 3;
  const resumeValidationMin = 3;
  const overhead = processMin + warmupMin + candidateQMin + resumeValidationMin;
  const assessableMin = Math.max(10, durationMinutes - overhead);

  const totalWeight = scored.reduce((a, c) => a + c.weight, 0) || 1;
  const blocks: PlanBlock[] = [];
  const coverageTargets: Record<string, number> = {};

  // Process / disclosure block.
  blocks.push({
    competencyId: '__process__', competencyName: 'Process & Consent',
    intent: 'Disclosure, consent confirmation, audio check and comfort.',
    targetMinutes: processMin, followupHints: ['Resolve technical or accommodation need.'], prohibited: [],
  });
  // Warmup / career relevance.
  blocks.push({
    competencyId: '__warmup__', competencyName: 'Career Relevance (Warmup)',
    intent: 'Current responsibilities and most relevant recent project.',
    targetMinutes: warmupMin, followupHints: ['Clarify ownership, scale and outcomes.'], prohibited: opts.role.policyRules.prohibitedTopics,
  });

  // One block per scored competency, weighted time.
  for (const c of scored) {
    const minutes = Math.max(3, Math.round((c.weight / totalWeight) * assessableMin));
    coverageTargets[c.id] = c.weight;
    const module = pickModule(c, modules);
    blocks.push({
      competencyId: c.id,
      competencyName: c.name,
      intent: intentFor(c),
      targetMinutes: minutes,
      followupHints: [
        'Situation: what was the context and constraints?',
        'Action: what did you personally do?',
        'Reasoning: why that approach; what trade-offs?',
        'Result: what was the measurable outcome?',
        'Learning: what would you change?',
      ],
      prohibited: opts.role.policyRules.prohibitedTopics,
      module,
    });
  }

  // Resume validation block (probe a high-value claim / fit gap).
  const probe = opts.fit?.probes?.[0] ?? 'Probe one high-value resume claim for personal contribution and measured result.';
  blocks.push({
    competencyId: '__resume_validation__', competencyName: 'Resume Validation',
    intent: probe, targetMinutes: resumeValidationMin,
    followupHints: ['Personal contribution and measured result.'], prohibited: opts.role.policyRules.prohibitedTopics,
  });
  // Candidate questions / close.
  blocks.push({
    competencyId: '__candidate_questions__', competencyName: 'Candidate Questions & Close',
    intent: 'Answer process questions and close professionally.',
    targetMinutes: candidateQMin,
    followupHints: ['No scoring from candidate personal questions unless job-related evidence emerges.'], prohibited: [],
  });

  return { durationMinutes, language, modules, blocks, coverageTargets };
}

function intentFor(c: { name: string; category: string }): string {
  switch (c.category) {
    case 'technical':
      return `Assess depth in ${c.name}: ask the candidate to reason through a real design or debugging scenario, using an artefact drawn from ${c.name} itself rather than a generic programming exercise.`;
    case 'domain':
      return `Assess applied ${c.name}: probe a concrete decision and its business impact.`;
    case 'communication':
      return 'Assess job-related clarity, structure, listening and audience adaptation (not accent or fluency style).';
    case 'situational':
      return `Present a realistic ${c.name} scenario and evaluate the reasoning process.`;
    default:
      return `Explore a specific example demonstrating ${c.name}, focusing on the candidate's own actions and outcomes.`;
  }
}

/**
 * Decide what kind of hands-on module, if any, this block can carry.
 *
 * An explicit operator opt-in still wins — if a tenant configured a coding
 * module, technical blocks get one. What changed is the default: rather than
 * "no module unless someone flipped a global switch", a block whose competency
 * admits work-sample evidence now carries a `document_review` module, and the
 * conversation runtime turns that into a small artefact drawn from the
 * competency's own domain.
 *
 * That distinction is the whole point. A Salesforce Administrator's blocks are
 * eligible for a work sample but never for `coding`, so they get a Flow, a
 * query or a sharing model to react to — not a Python function.
 */
function pickModule(c: Competency, modules: string[]): PlanBlock['module'] {
  if (modules.includes('coding') && c.category === 'technical') return 'coding';
  if (modules.includes('case') && (c.category === 'domain' || c.category === 'situational')) return 'case';
  if (isWorkSampleEligible(c)) return 'document_review';
  return undefined;
}
