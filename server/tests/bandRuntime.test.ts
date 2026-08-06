import { describe, it, expect } from 'vitest';
import type { Competency, DirectorSignal, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';
import { nextUtterance, type Persona } from '../src/engines/conversationRuntime.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import type { BandId } from '../src/engines/experienceBands.js';

// LLM_PROVIDER is pinned to `heuristic` for the suite, so `generateJson` returns
// null and every path here exercises the static question bank — which is exactly
// where a band-inappropriate template would come from.

const TECH: Competency = {
  id: 'c_tech',
  name: 'Data Engineering & Pipelines',
  definition: 'Builds and operates production data pipelines.',
  category: 'technical',
  classification: 'essential',
  weight: 0.6,
  requiredLevel: 2,
  targetLevel: 4,
  indicators: [],
  evidenceModes: ['technical_explanation'],
};

const BEHAVIOURAL: Competency = {
  id: 'c_beh',
  name: 'Problem Solving',
  definition: 'Breaks down ambiguous problems.',
  category: 'behavioral',
  classification: 'essential',
  weight: 0.4,
  requiredLevel: 2,
  targetLevel: 4,
  indicators: [],
  evidenceModes: ['behavioral_example'],
};

const ROLE: RoleSuccessProfile = {
  roleContext: 'Data engineering role.',
  outcomes: [], responsibilities: [], competencies: [TECH, BEHAVIOURAL],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};

const PERSONA: Persona = { name: 'Schranders', tone: 'warm' };

function turn(p: Partial<TurnRecord> & { speaker: TurnRecord['speaker']; text: string }): TurnRecord {
  return { id: Math.random().toString(36).slice(2), index: 0, startMs: 0, endMs: 1000, confidence: 1, ...p };
}

function signal(overrides: Partial<DirectorSignal> = {}): DirectorSignal {
  return {
    nextCompetencyId: TECH.id,
    action: 'ask',
    depthInstruction: 'hold',
    timeRemainingMinutes: 20,
    coverageState: {},
    reason: 'test',
    ...overrides,
  };
}

/** Ask for a fresh question at a band, cycling turns to walk the template bank. */
async function questionsAcrossBank(band: BandId, samples = 14): Promise<string[]> {
  const plan = buildInterviewPlan({ role: ROLE, band, durationMinutes: 45 });
  const out: string[] = [];
  for (let i = 0; i < samples; i++) {
    // Varying prior turns moves `pick()` through the bank deterministically.
    const turns: TurnRecord[] = [];
    for (let j = 0; j < i; j++) {
      turns.push(turn({ speaker: 'agent', text: `prior question ${j}`, competencyId: TECH.id, index: j * 2 }));
      turns.push(turn({ speaker: 'candidate', text: `prior answer ${j}`, competencyId: TECH.id, index: j * 2 + 1 }));
    }
    const u = await nextUtterance({
      plan, signal: signal({ coverageState: { [TECH.id]: 0 } }), turns, role: ROLE,
      persona: PERSONA, disclosureText: 'hello',
    });
    out.push(u.text);
  }
  return out;
}

describe('band-gated question selection', () => {
  /**
   * The concrete failure. The very first simulated interview asked a candidate
   * with one year of experience to diagnose a system they had "inherited... you
   * didn't build and nobody documented", then to decide when to move a dbt model
   * to incremental at ten times scale. Neither is answerable by someone who has
   * never owned a system.
   */
  it('never asks an entry-level candidate about a system they inherited', async () => {
    const asked = await questionsAcrossBank('emerging');
    for (const q of asked) {
      expect(q.toLowerCase(), q).not.toMatch(/inherited a .{0,40}(setup|system|platform)/);
      expect(q.toLowerCase(), q).not.toContain('nobody documented');
    }
  });

  it('never asks a developing candidate to reason at ten times scale', async () => {
    const asked = await questionsAcrossBank('developing');
    for (const q of asked) {
      expect(q.toLowerCase(), q).not.toContain('at ten times that scale');
    }
  });

  it('still asks established candidates the inherited-system question', async () => {
    // The gate must not simply delete hard questions from the bank — it must
    // withhold them from the people who cannot answer them.
    const asked = await questionsAcrossBank('established', 20);
    expect(asked.some((q) => /inherited/i.test(q))).toBe(true);
  });

  it('always produces a usable question, even when the band blocks templates', async () => {
    for (const band of ['emerging', 'developing', 'established', 'senior', 'principal', 'executive'] as const) {
      for (const q of await questionsAcrossBank(band, 6)) {
        expect(q.trim().length, `${band}: "${q}"`).toBeGreaterThan(15);
      }
    }
  });

  it('leaves the bank untouched at the top bands', async () => {
    const asked = await questionsAcrossBank('principal', 20);
    expect(new Set(asked).size).toBeGreaterThan(1);
  });
});

describe('band gating applies to whatever produced the question', () => {
  it('screens a follow-up escalation that presumes scale the candidate lacks', async () => {
    // The escalation ladder's second rung is "at ten times that scale, which
    // part breaks first" — reasonable for a senior, meaningless for a fresher
    // who has never run the thing once.
    const plan = buildInterviewPlan({ role: ROLE, band: 'emerging', durationMinutes: 45 });
    const turns = [
      turn({ speaker: 'agent', text: 'Tell me about a pipeline you worked on.', competencyId: TECH.id, index: 0 }),
      turn({ speaker: 'candidate', index: 1, competencyId: TECH.id, text: 'I built the nightly load. I wrote the transform, tested it, and it cut runtime from 90 minutes to 8, about 35% cheaper.' }),
    ];
    const u = await nextUtterance({
      plan,
      signal: signal({ action: 'followup', depthInstruction: 'increase', coverageState: { [TECH.id]: 1 } }),
      turns, role: ROLE, persona: PERSONA, disclosureText: 'hello',
    });
    expect(u.text.toLowerCase()).not.toContain('at ten times that scale');
    expect(u.text.trim().length).toBeGreaterThan(15);
  });
});

describe('every band keeps a full spread of question forms', () => {
  it('still offers entry-level candidates a hypothetical, in words they can answer', async () => {
    // Gating the inherited-system wording must not cost the craft bands the
    // FORM. Losing a form narrows the bank, and a narrow bank is what produced
    // four identically-shaped questions in a row in the transcript that started
    // all of this.
    const asked = await questionsAcrossBank('emerging', 20);
    expect(asked.some((q) => /\bsuppose\b/i.test(q))).toBe(true);
    expect(asked.some((q) => /instructions turned out to be wrong/i.test(q))).toBe(true);
  });

  it('gives the craft bands at least four distinct forms to draw on', async () => {
    const { classifyForm } = await import('../src/engines/conversationRuntime.js');
    for (const band of ['emerging', 'developing'] as const) {
      const forms = new Set((await questionsAcrossBank(band, 20)).map(classifyForm));
      forms.delete('other');
      expect(forms.size, `${band}: ${[...forms].join(', ')}`).toBeGreaterThanOrEqual(4);
    }
  });
});
