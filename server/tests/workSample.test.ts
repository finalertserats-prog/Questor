import { describe, it, expect } from 'vitest';
import type { Competency, DirectorSignal, InterviewPlan, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';
import {
  isWorkSampleEligible,
  workSampleFormFor,
  shouldOfferWorkSample,
  buildWorkSample,
  countWorkSamples,
  WORK_SAMPLE_LEAD_IN,
} from '../src/engines/workSample.js';
import {
  nextUtterance,
  classifyForm,
  buildFollowup,
  detectCorrection,
  applyCorrection,
  type Persona,
} from '../src/engines/conversationRuntime.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { directorDecide, answersNeeded } from '../src/engines/interviewDirector.js';

// The ground truth for this whole file is a real transcript: a Salesforce
// Administrator was asked four consecutive "Can you describe a specific/
// challenging situation where..." questions and asked to leave. He also
// corrected a mis-transcription ("not farmer company, it's Pharma") and the
// next question was built on the error anyway.

const SF_SHARING: Competency = {
  id: 'c_sharing',
  name: 'Sharing & Visibility Model',
  definition: 'Designs and debugs org-wide defaults, role hierarchy and sharing rules so the right users see the right records.',
  category: 'technical',
  classification: 'essential',
  weight: 0.4,
  requiredLevel: 3,
  targetLevel: 4,
  indicators: [],
  evidenceModes: ['technical_explanation', 'work_sample'],
};

const SF_COLLABORATION: Competency = {
  id: 'c_collab',
  name: 'Stakeholder Collaboration',
  definition: 'Works with sales and ops stakeholders to turn vague asks into workable requirements.',
  category: 'behavioral',
  classification: 'essential',
  weight: 0.3,
  requiredLevel: 3,
  targetLevel: 4,
  indicators: [],
  evidenceModes: ['behavioral_example'],
};

const SF_COMMS: Competency = {
  id: 'c_comms',
  name: 'Communication',
  definition: 'Explains technical constraints to non-technical audiences.',
  category: 'communication',
  classification: 'essential',
  weight: 0.3,
  requiredLevel: 3,
  targetLevel: 4,
  indicators: [],
  evidenceModes: ['behavioral_example', 'technical_explanation'],
};

const ROLE: RoleSuccessProfile = {
  roleContext: 'Salesforce Administrator for a pharmaceutical distributor.',
  outcomes: [],
  responsibilities: [],
  competencies: [SF_SHARING, SF_COLLABORATION, SF_COMMS],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [],
  seniority: 'mid',
};

const PERSONA: Persona = { name: 'Schranders', tone: 'warm' };

function turn(partial: Partial<TurnRecord> & { speaker: TurnRecord['speaker']; text: string }): TurnRecord {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    index: partial.index ?? 0,
    startMs: 0,
    endMs: 1000,
    confidence: 1,
    competencyId: partial.competencyId,
    ...partial,
  };
}

function signalFor(overrides: Partial<DirectorSignal> = {}): DirectorSignal {
  return {
    nextCompetencyId: SF_SHARING.id,
    action: 'followup',
    depthInstruction: 'hold',
    timeRemainingMinutes: 20,
    coverageState: { [SF_SHARING.id]: 1 },
    reason: 'test',
    ...overrides,
  };
}

const PLAN: InterviewPlan = buildInterviewPlan({ role: ROLE, durationMinutes: 45 });

/**
 * The director walks blocks in plan order, so a test that wants an opinion
 * about a competency block has to get past process and warmup first.
 */
function withPreamble(...rest: TurnRecord[]): TurnRecord[] {
  const preamble: TurnRecord[] = [
    turn({ speaker: 'agent', index: 0, text: 'Disclosure.', competencyId: '__process__' }),
    turn({ speaker: 'candidate', index: 1, text: 'Yes, I can hear you.', competencyId: '__process__' }),
    turn({ speaker: 'agent', index: 2, text: 'Tell me about your current role.', competencyId: '__warmup__' }),
    turn({ speaker: 'candidate', index: 3, text: 'I administer Salesforce for a pharma distributor.', competencyId: '__warmup__' }),
  ];
  return [...preamble, ...rest.map((t, i) => ({ ...t, index: preamble.length + i }))];
}

// --- Eligibility: who gets a work sample -----------------------------------

describe('work sample eligibility', () => {
  it('offers a work sample for a technical competency', () => {
    expect(isWorkSampleEligible(SF_SHARING)).toBe(true);
    expect(
      shouldOfferWorkSample({ competency: SF_SHARING, turns: [], answersHere: 1, action: 'followup' }),
    ).toBe(true);
  });

  it('never offers one for a behavioural competency', () => {
    expect(isWorkSampleEligible(SF_COLLABORATION)).toBe(false);
    expect(
      shouldOfferWorkSample({ competency: SF_COLLABORATION, turns: [], answersHere: 1, action: 'followup' }),
    ).toBe(false);
  });

  it('never offers one for a communication competency', () => {
    expect(isWorkSampleEligible(SF_COMMS)).toBe(false);
  });

  it('trusts declared evidence modes for a non-technical competency', () => {
    const domainWithSample: Competency = { ...SF_SHARING, id: 'c_dom', category: 'domain', evidenceModes: ['work_sample'] };
    const domainWithout: Competency = { ...SF_SHARING, id: 'c_dom2', category: 'domain', evidenceModes: ['behavioral_example'] };
    expect(isWorkSampleEligible(domainWithSample)).toBe(true);
    expect(isWorkSampleEligible(domainWithout)).toBe(false);
  });

  it('does not open a block with a work sample', () => {
    // answersHere === 0 means the candidate has not spoken about the area yet.
    expect(
      shouldOfferWorkSample({ competency: SF_SHARING, turns: [], answersHere: 0, action: 'ask' }),
    ).toBe(false);
  });

  it('does not offer the same competency two work samples', () => {
    const turns = [turn({ speaker: 'agent', text: `${WORK_SAMPLE_LEAD_IN} something`, competencyId: SF_SHARING.id })];
    expect(shouldOfferWorkSample({ competency: SF_SHARING, turns, answersHere: 2, action: 'followup' })).toBe(false);
  });

  it('never interrupts the close with one', () => {
    expect(
      shouldOfferWorkSample({ competency: SF_SHARING, turns: [], answersHere: 2, action: 'close' }),
    ).toBe(false);
  });
});

describe('work sample form', () => {
  it('only produces a coding artefact when a coding module was configured', () => {
    expect(workSampleFormFor(SF_SHARING)).not.toBe('coding');
    expect(workSampleFormFor(SF_SHARING, 'document_review')).not.toBe('coding');
    expect(workSampleFormFor(SF_SHARING, 'coding')).toBe('coding');
  });

  it('builds a short, typeable artefact with zero LLM configured', async () => {
    const sample = await buildWorkSample({ competency: SF_SHARING, role: ROLE });
    expect(sample.prompt.startsWith(WORK_SAMPLE_LEAD_IN)).toBe(true);
    expect(sample.prompt).toContain(SF_SHARING.name);
    expect(sample.prompt.toLowerCase()).toContain('type your answer');
    // A first-round screen, not a take-home.
    expect(sample.prompt.length).toBeLessThan(700);
  });

  it('does not invent a programming language for a Salesforce admin competency', async () => {
    const sample = await buildWorkSample({ competency: SF_SHARING, role: ROLE });
    for (const lang of ['python', 'javascript', 'java ', 'c++', 'def ', 'function(']) {
      expect(sample.prompt.toLowerCase()).not.toContain(lang);
    }
  });
});

describe('planner module derivation', () => {
  it('marks a technical block as carrying a document-review artefact, not code', () => {
    const block = PLAN.blocks.find((b) => b.competencyId === SF_SHARING.id);
    expect(block?.module).toBe('document_review');
  });

  it('leaves behavioural and communication blocks with no module', () => {
    expect(PLAN.blocks.find((b) => b.competencyId === SF_COLLABORATION.id)?.module).toBeUndefined();
    expect(PLAN.blocks.find((b) => b.competencyId === SF_COMMS.id)?.module).toBeUndefined();
  });

  it('honours an explicit coding module opt-in', () => {
    const plan = buildInterviewPlan({ role: ROLE, durationMinutes: 45, modules: ['coding'] });
    expect(plan.blocks.find((b) => b.competencyId === SF_SHARING.id)?.module).toBe('coding');
    // ...but still never on a behavioural block.
    expect(plan.blocks.find((b) => b.competencyId === SF_COLLABORATION.id)?.module).toBeUndefined();
  });
});

// --- Question variety -------------------------------------------------------

describe('question form variety', () => {
  it('recognises the four consecutive forms from the real transcript as one form', () => {
    for (const q of [
      'Can you describe a specific decision you made in the lead to account mapping process?',
      'Can you describe a specific instance where you had to debug a flow or automation?',
      'Can you describe a challenging situation where you had to design a sharing and visibility model?',
      'Can you describe a situation where you had to implement a data management strategy?',
    ]) {
      expect(classifyForm(q), q).toBe('star');
    }
  });

  it('tells the other forms apart', () => {
    expect(classifyForm('What do you think is overrated about data modelling?')).toBe('opinion');
    expect(classifyForm('When have you pushed back on a request like that?')).toBe('disagreement');
    expect(classifyForm('Suppose you inherited a setup nobody documented.')).toBe('hypothetical');
    expect(classifyForm('Walk me through, step by step, how that lands with you.')).toBe('walkthrough');
    expect(classifyForm(`${WORK_SAMPLE_LEAD_IN} Here is a query.`)).toBe('work_sample');
  });

  it('does not ask the same form twice in a row across a whole interview', async () => {
    // Drive the real loop: director decides, runtime speaks, candidate answers.
    const turns: TurnRecord[] = [];
    const forms: string[] = [];
    for (let i = 0; i < 14; i++) {
      const signal = directorDecide({ plan: PLAN, turns, elapsedMinutes: i * 1.5 });
      const utter = await nextUtterance({
        plan: PLAN, signal, turns, role: ROLE, persona: PERSONA, disclosureText: '',
      });
      if (utter.kind === 'signoff' || utter.kind === 'withdrawn') break;
      turns.push(turn({ speaker: 'agent', index: turns.length, text: utter.text, competencyId: utter.competencyId }));
      if (!utter.competencyId.startsWith('__')) forms.push(classifyForm(utter.text));
      turns.push(turn({
        speaker: 'candidate', index: turns.length, competencyId: utter.competencyId,
        text: 'When we rolled out the new territory model I audited the sharing rules, I rebuilt the role hierarchy, and we reduced access escalation tickets by 40%.',
      }));
    }

    expect(forms.length).toBeGreaterThan(3);
    for (let i = 1; i < forms.length; i++) {
      expect(forms[i], `form repeated consecutively at ${i}: ${forms.slice(0, i + 1).join(' -> ')}`)
        .not.toBe(forms[i - 1]);
    }
    // And the interview is not four STAR questions wearing different hats.
    expect(new Set(forms).size).toBeGreaterThan(2);
  });

  it('reaches a work sample during a normal technical interview', async () => {
    const turns: TurnRecord[] = [];
    let sawWorkSample = false;
    for (let i = 0; i < 14; i++) {
      const signal = directorDecide({ plan: PLAN, turns, elapsedMinutes: i * 1.5 });
      const utter = await nextUtterance({
        plan: PLAN, signal, turns, role: ROLE, persona: PERSONA, disclosureText: '',
      });
      if (utter.kind === 'work_sample') {
        sawWorkSample = true;
        // Never on a competency that cannot carry one.
        expect(utter.competencyId).toBe(SF_SHARING.id);
      }
      if (utter.kind === 'signoff' || utter.kind === 'withdrawn') break;
      turns.push(turn({ speaker: 'agent', index: turns.length, text: utter.text, competencyId: utter.competencyId }));
      turns.push(turn({
        speaker: 'candidate', index: turns.length, competencyId: utter.competencyId,
        text: 'When we rolled out the new territory model I audited the sharing rules and we reduced escalation tickets by 40%.',
      }));
    }
    expect(sawWorkSample).toBe(true);
    expect(countWorkSamples(turns)).toBeGreaterThan(0);
    expect(countWorkSamples(turns)).toBeLessThanOrEqual(2);
  });
});

// --- Difficulty that moves --------------------------------------------------

// Deliberately phrased so answerQuality sees all four of situation, action,
// result and specificity — this fixture is about what the director does with a
// strong answer, not about how well it detects one.
const STRONG_ANSWER =
  'When our lead-to-account matching broke I traced it to a duplicate rule, I rebuilt the matching keys and backfilled 40,000 records, which reduced misrouted leads by 60%.';
const WEAK_ANSWER = 'I did some stuff with that.';

describe('difficulty responds to answer quality', () => {
  it('escalates a strong answer above a weak one', () => {
    const strong = buildFollowup(STRONG_ANSWER, 'increase', 1);
    const weak = buildFollowup(WEAK_ANSWER, 'decrease', 1);
    expect(strong.tier).toBeGreaterThan(weak.tier);
  });

  it('makes the escalation visible in the words, not just a flag', () => {
    const strong = buildFollowup(STRONG_ANSWER, 'increase', 1).text.toLowerCase();
    expect(strong).toMatch(/argument against|scale|breaks first|edge case/);
  });

  it('eases off rather than punishing a weak answer', () => {
    const weak = buildFollowup(WEAK_ANSWER, 'decrease', 1).text.toLowerCase();
    expect(weak).not.toMatch(/harder|edge case|breaks first/);
    expect(weak).toMatch(/context|constraints|easier|just one part/);
  });

  it('does not repeat itself when it pushes twice', () => {
    const first = buildFollowup(STRONG_ANSWER, 'increase', 1).text;
    const second = buildFollowup(STRONG_ANSWER, 'increase', 2).text;
    expect(first).not.toBe(second);
  });

  it('gives a strong answer a harder follow-up than a weak one end to end', async () => {
    const ask = turn({ speaker: 'agent', text: 'Tell me about the sharing model you own.', competencyId: SF_SHARING.id });
    const strongTurns = withPreamble(ask, turn({ speaker: 'candidate', text: STRONG_ANSWER, competencyId: SF_SHARING.id }));
    const weakTurns = withPreamble(ask, turn({ speaker: 'candidate', text: WEAK_ANSWER, competencyId: SF_SHARING.id }));

    // Let the director grade each answer for itself rather than asserting a
    // depth we chose — the point is that quality drives difficulty.
    const strongSignal = directorDecide({ plan: PLAN, turns: strongTurns, elapsedMinutes: 5 });
    const weakSignal = directorDecide({ plan: PLAN, turns: weakTurns, elapsedMinutes: 5 });
    expect(strongSignal.depthInstruction).toBe('increase');
    expect(weakSignal.depthInstruction).not.toBe('increase');

    const strongText = buildFollowup(STRONG_ANSWER, strongSignal.depthInstruction, 1);
    const weakText = buildFollowup(WEAK_ANSWER, weakSignal.depthInstruction, 1);
    expect(strongText.tier).toBeGreaterThan(weakText.tier);
    expect(strongText.text).not.toBe(weakText.text);
  });

  it('still lets a strong answer earn a follow-up on a one-answer block', () => {
    // A low-weight competency in a short interview gets a quota of exactly one
    // answer. That is precisely where the old behaviour was worst: answering
    // well bought the candidate a change of subject.
    const thinRole: RoleSuccessProfile = {
      ...ROLE,
      competencies: [
        { ...SF_SHARING, weight: 0.1 },
        { ...SF_COLLABORATION, weight: 0.45 },
        { ...SF_COMMS, weight: 0.45 },
      ],
    };
    const thinPlan = buildInterviewPlan({ role: thinRole, durationMinutes: 20 });
    expect(answersNeeded(thinPlan.blocks.find((b) => b.competencyId === SF_SHARING.id)!)).toBe(1);

    const turns = withPreamble(
      turn({ speaker: 'agent', text: 'Tell me about the sharing model you own.', competencyId: SF_SHARING.id }),
      turn({ speaker: 'candidate', text: STRONG_ANSWER, competencyId: SF_SHARING.id }),
    );
    const signal = directorDecide({ plan: thinPlan, turns, elapsedMinutes: 5 });
    expect(signal.action).toBe('followup');
    expect(signal.depthInstruction).toBe('increase');
  });
});

// --- Corrections ------------------------------------------------------------

describe('acknowledging a correction', () => {
  it('catches the correction the real candidate actually made', () => {
    const c = detectCorrection("it's actually not farmer company, it's Pharma");
    expect(c).not.toBeNull();
    expect(c!.wrong.toLowerCase()).toContain('farmer');
    expect(c!.right.toLowerCase()).toContain('pharma');
  });

  it('catches the other common phrasings', () => {
    expect(detectCorrection('I said Pharma, not farmer')?.right.toLowerCase()).toContain('pharma');
    expect(detectCorrection('not Redshift, Snowflake')?.right.toLowerCase()).toContain('snowflake');
  });

  it('does not fire on ordinary answers', () => {
    expect(detectCorrection('I built a pipeline that reduced failures by 60%')).toBeNull();
    expect(detectCorrection('We work with pharma distributors')).toBeNull();
  });

  it('does not read an ordinary "not X, Y" sentence as a correction', () => {
    // From a simulated interview: the bare pattern has no correction frame
    // around it, so it matched a candidate simply continuing their sentence.
    // The interviewer then said "Thanks for the correction — so that part I'm
    // not worried about, noted", which is both false and unreadable.
    expect(detectCorrection(
      "The uniqueness test stays cheap since it's just checking the output, not reprocessing everything, so that part I'm not worried about.",
    )).toBeNull();
  });

  it('does not fire when the replacement is a clause rather than a term', () => {
    expect(detectCorrection('I focused on the model, not the pipeline, because that was the bottleneck')).toBeNull();
    expect(detectCorrection('We chose Kafka, not because it was cheaper, but it was what we knew')).toBeNull();
  });

  it('still catches a terse correction between two short terms', () => {
    expect(detectCorrection('not Redshift, Snowflake')?.right.toLowerCase()).toContain('snowflake');
    expect(detectCorrection('not Azure, AWS')?.right.toLowerCase()).toContain('aws');
  });

  it('never repeats the wrong term in the next question', () => {
    const corrected = applyCorrection(
      'Tell me more about the farmer company work you did.',
      { wrong: 'farmer company', right: 'Pharma' },
    );
    expect(corrected.toLowerCase()).not.toContain('farmer');
    expect(corrected).toContain('Pharma');
  });

  it('carries the correction into the next real utterance', async () => {
    const turns = [
      turn({ speaker: 'agent', index: 0, text: 'Tell me about your farmer company work.', competencyId: SF_SHARING.id }),
      turn({ speaker: 'candidate', index: 1, text: "it's actually not farmer company, it's Pharma", competencyId: SF_SHARING.id }),
    ];
    const utter = await nextUtterance({
      plan: PLAN, signal: signalFor({ coverageState: { [SF_SHARING.id]: 1 } }),
      turns, role: ROLE, persona: PERSONA, disclosureText: '',
    });
    expect(utter.text.toLowerCase()).toContain('correction');
    expect(utter.text.toLowerCase()).not.toContain('farmer');
  });
});

// --- Zero-key completeness --------------------------------------------------

describe('zero-key degradation', () => {
  it('runs a complete interview to sign-off with no LLM configured', async () => {
    const turns: TurnRecord[] = [];
    let signedOff = false;
    for (let i = 0; i < 40 && !signedOff; i++) {
      const signal = directorDecide({ plan: PLAN, turns, elapsedMinutes: i * 2 });
      const utter = await nextUtterance({
        plan: PLAN, signal, turns, role: ROLE, persona: PERSONA, disclosureText: '',
      });
      expect(utter.text.length).toBeGreaterThan(10);
      turns.push(turn({ speaker: 'agent', index: turns.length, text: utter.text, competencyId: utter.competencyId }));
      if (utter.kind === 'signoff') { signedOff = true; break; }
      turns.push(turn({
        speaker: 'candidate', index: turns.length, competencyId: utter.competencyId,
        text: 'We rebuilt the role hierarchy and reduced escalations by 40%.',
      }));
    }
    expect(signedOff).toBe(true);
  });

  it('still stops immediately when the candidate withdraws', async () => {
    const turns = [
      turn({ speaker: 'agent', index: 0, text: 'Tell me about the sharing model you own.', competencyId: SF_SHARING.id }),
      turn({ speaker: 'candidate', index: 1, text: "Well you know what I think I'm going to end the interview", competencyId: SF_SHARING.id }),
    ];
    const utter = await nextUtterance({
      plan: PLAN, signal: signalFor(), turns, role: ROLE, persona: PERSONA, disclosureText: '',
    });
    expect(utter.kind).toBe('withdrawn');
  });
});
