import type { Competency, FitScore, InterviewPlan, PlanBlock, RoleSuccessProfile } from '../domain/types.js';
import { isWorkSampleEligible } from './workSample.js';
import { bandForRoleSeniority, bandGuidanceFor } from './bandCalibration.js';
import type { BandId } from './experienceBands.js';

// Interview plan builder (BRD FR-016, Appendix 25.1). Produces comparable
// competency coverage while reserving process, warmup, resume-validation and
// candidate-question blocks. Time is allocated by competency weight.

export function buildInterviewPlan(opts: {
  role: RoleSuccessProfile;
  fit?: FitScore;
  durationMinutes?: number;
  language?: string;
  modules?: string[];
  /**
   * The candidate's experience band. Falls back to the ROLE's level when the
   * caller has not resolved one — worse than reading the candidate, but far
   * better than the single binary check this replaced.
   */
  band?: BandId;
  bandRationale?: string;
}): InterviewPlan {
  const durationMinutes = opts.durationMinutes ?? 45;
  const language = opts.language ?? 'en';
  const modules = opts.modules ?? [];
  const band = opts.band ?? bandForRoleSeniority(opts.role.seniority).id;
  const bandGuidance = bandGuidanceFor(band);
  const scored = opts.role.competencies.filter((c) => c.classification !== 'non_scoring');

  // Fit the plan to the time it actually has.
  //
  // This used to allocate a flat 3 minutes minimum per competency on top of 13
  // minutes of fixed overhead, with no reference to the duration at all. A
  // 12-minute interview with seven competencies was planned as 34 minutes of
  // blocks. The director simply ran out of time and closed, three blocks were
  // never asked — including Resume Validation — and the assessment then reported
  // those competencies as lacking evidence.
  //
  // That last step is the harm: the candidate was marked down for questions
  // nobody put to them, and coverage below 0.4 forces a CONSIDER recommendation.
  // A plan that cannot be delivered is not a plan, it is a way of blaming the
  // candidate for the clock.
  const budget = allocateTime(durationMinutes, scored);
  const { processMin, warmupMin, candidateQMin, resumeValidationMin } = budget;
  const fitted = budget.fitted;
  const notAssessed = budget.notAssessed.map((c) => c.name);

  const totalWeight = fitted.reduce((a, c) => a + c.weight, 0) || 1;
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

  // One block per competency that fits, weighted time.
  for (const [i, c] of fitted.entries()) {
    const minutes = budget.competencyMinutes[i];
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
      bandGuidance,
    });
  }

  // Resume validation block (probe a high-value claim / fit gap). Dropped under
  // time pressure rather than planned and then silently never reached — a block
  // that cannot run is more honest as an absence than as an unmet promise.
  if (resumeValidationMin > 0) {
    const probe = opts.fit?.probes?.[0] ?? 'Probe one high-value resume claim for personal contribution and measured result.';
    blocks.push({
      competencyId: '__resume_validation__', competencyName: 'Resume Validation',
      intent: probe, targetMinutes: resumeValidationMin,
      followupHints: ['Personal contribution and measured result.'], prohibited: opts.role.policyRules.prohibitedTopics,
      bandGuidance,
    });
  }
  // Candidate questions / close.
  blocks.push({
    competencyId: '__candidate_questions__', competencyName: 'Candidate Questions & Close',
    intent: 'Answer process questions and close professionally.',
    targetMinutes: candidateQMin,
    followupHints: ['No scoring from candidate personal questions unless job-related evidence emerges.'], prohibited: [],
  });

  return {
    durationMinutes, language, modules, blocks, coverageTargets, band,
    bandRationale: opts.bandRationale,
    ...(notAssessed.length ? { notAssessed } : {}),
  };
}

/** Shortest block worth asking. Below this there is no time for a real answer. */
const MIN_COMPETENCY_MINUTES = 2;

interface TimeBudget {
  processMin: number;
  warmupMin: number;
  candidateQMin: number;
  resumeValidationMin: number;
  fitted: Competency[];
  notAssessed: Competency[];
  /** Minutes per fitted competency, index-aligned with `fitted`. */
  competencyMinutes: number[];
}

/**
 * Divide the interview's minutes between its fixed blocks and its competencies,
 * spending no more than there are.
 *
 * Order of precedence is deliberate. Disclosure and close are close to
 * non-negotiable: one is how consent is obtained, the other is the difference
 * between an interview ending and a call dropping. Warmup earns its place next
 * because a candidate who has not spoken yet answers the first real question
 * badly. Resume validation yields before competencies, and the lowest-weight
 * competencies yield before the highest — if something must go unasked, it
 * should be the thing the role cares least about.
 */
function allocateTime(durationMinutes: number, scored: Competency[]): TimeBudget {
  const tenth = Math.floor(durationMinutes * 0.15);
  const processMin = Math.min(3, Math.max(1, tenth));
  const candidateQMin = Math.min(3, Math.max(1, tenth));
  let remaining = Math.max(0, durationMinutes - processMin - candidateQMin);

  const warmupMin = remaining >= 6 ? 4 : remaining >= 4 ? 2 : 0;
  remaining -= warmupMin;

  const resumeValidationMin = remaining >= MIN_COMPETENCY_MINUTES + 3 ? 3 : 0;
  remaining -= resumeValidationMin;

  // Weight decides WHAT survives, never in what order it is asked.
  //
  // Sorting the blocks themselves by weight quietly rewrote the interview's
  // running order, and a low-weight competency that used to be asked first was
  // pushed to the end. Selection and sequencing are different decisions: the
  // role's declared order is a deliberate shape, and a fitting rule has no
  // business rearranging it.
  const byWeight = [...scored].sort((a, b) => b.weight - a.weight);
  const capacity = Math.floor(remaining / MIN_COMPETENCY_MINUTES);
  // Always assess at least one thing; an interview that assesses nothing is not
  // an interview, however short the slot.
  const fitCount = Math.max(1, Math.min(byWeight.length, capacity));
  const keep = new Set(byWeight.slice(0, fitCount).map((c) => c.id));

  const fitted = scored.filter((c) => keep.has(c.id));
  const notAssessed = scored.filter((c) => !keep.has(c.id));

  const floor = Math.min(MIN_COMPETENCY_MINUTES, Math.max(1, remaining));
  const totalWeight = fitted.reduce((a, c) => a + c.weight, 0) || 1;
  const competencyMinutes = fitted.map((c) =>
    Math.max(floor, Math.floor((c.weight / totalWeight) * remaining)),
  );

  // Rounding up from the floor can overshoot; trim the largest blocks until the
  // total fits. Guaranteed to terminate because fitCount * floor <= remaining
  // whenever capacity >= 1.
  let spent = competencyMinutes.reduce((a, b) => a + b, 0);
  while (spent > remaining && competencyMinutes.some((m) => m > floor)) {
    const i = competencyMinutes.indexOf(Math.max(...competencyMinutes));
    competencyMinutes[i]--;
    spent--;
  }

  return { processMin, warmupMin, candidateQMin, resumeValidationMin, fitted, notAssessed, competencyMinutes };
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
