import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Competency, RoleSuccessProfile } from '../src/domain/types.js';
import type { LlmMessage } from '../src/providers/llm/types.js';
import type { BandId } from '../src/engines/experienceBands.js';

// Band-calibrated work samples.
//
// A tri-model evaluation scored the interview well on calibration everywhere
// EXCEPT here: a graduate and a principal engineer were handed practical
// exercises of the same shape and the same scope, because `workSample.ts` chose
// a form from the competency alone and never consulted the band the rest of the
// interview was already pitched at.
//
// The suite runs with LLM_PROVIDER=heuristic, so the zero-key path is the
// default here. Where the model path matters — does the prompt actually carry
// the band guidance, and is a band-inappropriate exercise refused — we point
// config at Anthropic and swap the connector for a scriptable fake, so the real
// generateJson, validation and screening all run.

const script = vi.hoisted(() => ({
  /** 'off' reproduces the zero-key provider (enabled=false). */
  mode: 'off' as 'off' | 'ok',
  prompt: '' as string,
  seen: [] as LlmMessage[][],
}));

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return { config: { ...actual.config, llm: { ...actual.config.llm, provider: 'anthropic', anthropicKey: 'test-key' } } };
});

vi.mock('../src/providers/llm/anthropic.js', () => ({
  AnthropicLlmProvider: class {
    name = 'anthropic';
    // A getter, not a field: `getLlm` caches the instance, so the enabled flag
    // has to stay live for a test to toggle the provider off.
    get enabled(): boolean { return script.mode !== 'off'; }
    async generate(messages: LlmMessage[]) {
      script.seen.push(messages);
      return {
        text: JSON.stringify({ prompt: script.prompt }),
        model: 'fake-model', inputTokens: 300, outputTokens: 90, latencyMs: 8,
      };
    }
  },
}));

const {
  buildWorkSample,
  workSampleFormFor,
  workSampleFormsForBand,
  workSampleScopeForBand,
  workSampleBlockReason,
  WORK_SAMPLE_LEAD_IN,
} = await import('../src/engines/workSample.js');
const { bandGuidanceFor } = await import('../src/engines/bandCalibration.js');
const { bandById } = await import('../src/engines/experienceBands.js');
const { _resetLlm } = await import('../src/providers/llm/index.js');

// ---- fixtures ----

const PIPELINES: Competency = {
  id: 'c_pipelines',
  name: 'Data Pipelines',
  definition: 'Builds and operates the pipelines that land and transform production data.',
  category: 'technical',
  classification: 'essential',
  weight: 0.5,
  requiredLevel: 3,
  targetLevel: 4,
  indicators: [],
  evidenceModes: ['technical_explanation', 'work_sample'],
};

const INCIDENTS: Competency = {
  id: 'c_incidents',
  name: 'Incident Handling',
  definition: 'Responds to production failures under time pressure.',
  category: 'situational',
  classification: 'essential',
  weight: 0.5,
  requiredLevel: 3,
  targetLevel: 4,
  indicators: [],
  evidenceModes: ['work_sample'],
};

const ROLE: RoleSuccessProfile = {
  roleContext: 'Data engineering for a pharmaceutical distributor.',
  outcomes: [], responsibilities: [], competencies: [PIPELINES, INCIDENTS],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};

const ALL_BANDS: BandId[] = ['emerging', 'developing', 'established', 'senior', 'principal', 'executive'];
const CRAFT_BANDS: BandId[] = ['emerging', 'developing'];
const SYSTEM_BANDS: BandId[] = ['established', 'senior'];
const ORG_BANDS: BandId[] = ['principal', 'executive'];

/** Vocabulary that presumes organisational authority the craft bands never had. */
const ORG_LANGUAGE = [
  /\bacross (multiple|several|\w+) teams\b/i,
  /\borg[- ]wide\b/i,
  /\bcompany[- ]wide\b/i,
  /\bbuild[- ]versus[- ]buy\b/i,
  /\bheadcount\b/i,
  /\bp&l\b/i,
  /\bportfolio\b/i,
];

/** Vocabulary that treats a veteran's judgement as a line-level exercise. */
const LINE_LEVEL_LANGUAGE = [
  /\bwrite (a|the) (loop|function|query)\b/i,
  /\bloops over\b/i,
  /\bline of code\b/i,
  /\bsyntax\b/i,
];

beforeEach(() => {
  script.mode = 'off';
  script.prompt = '';
  script.seen = [];
  _resetLlm();
});

// --- Which form suits which band -------------------------------------------

describe('work sample form is chosen for the band', () => {
  it('maps each band to the abstraction its own definition declares', () => {
    for (const band of ALL_BANDS) {
      expect(workSampleScopeForBand(band), band).toBe(
        { craft: 'artifact', system: 'subsystem', organisation: 'organisation' }[bandById(band).abstraction],
      );
    }
  });

  it('gives craft-level bands concrete forms only', () => {
    for (const band of CRAFT_BANDS) {
      const forms = workSampleFormsForBand(band);
      expect(forms, band).toContain('artifact_review');
      expect(forms, band).toContain('diagnostic');
      // Sketching a structure or arbitrating someone else's approach both
      // presume a seat at a table an emerging candidate has never sat at.
      expect(forms, band).not.toContain('design_sketch');
      expect(forms, band).not.toContain('critique');
    }
  });

  it('gives organisation-level bands trade-off forms, not hands-on ones', () => {
    for (const band of ORG_BANDS) {
      const forms = workSampleFormsForBand(band);
      expect(forms, band).toContain('design_sketch');
      expect(forms, band).toContain('critique');
      expect(forms, band).not.toContain('artifact_review');
      expect(forms, band).not.toContain('diagnostic');
    }
  });

  it('leaves the system bands the full spread', () => {
    for (const band of SYSTEM_BANDS) {
      const forms = workSampleFormsForBand(band);
      for (const f of ['artifact_review', 'diagnostic', 'design_sketch', 'critique']) {
        expect(forms, `${band}/${f}`).toContain(f);
      }
    }
  });

  it('picks a band-legal form for the same competency at every band', () => {
    for (const band of ALL_BANDS) {
      const form = workSampleFormFor(PIPELINES, undefined, band);
      expect(workSampleFormsForBand(band), `${band} -> ${form}`).toContain(form);
    }
  });

  it('hands a graduate and a principal different shapes of exercise', () => {
    expect(workSampleFormFor(PIPELINES, undefined, 'emerging'))
      .not.toBe(workSampleFormFor(PIPELINES, undefined, 'principal'));
  });

  it('stays deterministic per competency and band', () => {
    for (const band of ALL_BANDS) {
      expect(workSampleFormFor(PIPELINES, undefined, band)).toBe(workSampleFormFor(PIPELINES, undefined, band));
    }
  });

  it('keeps a situational competency inside the band as well as the category', () => {
    for (const band of ALL_BANDS) {
      const form = workSampleFormFor(INCIDENTS, undefined, band);
      expect(workSampleFormsForBand(band), `${band} -> ${form}`).toContain(form);
    }
  });

  it('still honours an explicit coding module at every band', () => {
    // A coding module is an operator decision about the job, not about the
    // candidate's seniority; the band changes the SCOPE of the code exercise,
    // not whether one happens.
    for (const band of ALL_BANDS) {
      expect(workSampleFormFor(PIPELINES, 'coding', band), band).toBe('coding');
    }
  });

  it('behaves exactly as before when no band is known', () => {
    expect(workSampleFormFor(PIPELINES)).not.toBe('coding');
    expect(workSampleFormFor(PIPELINES, 'coding')).toBe('coding');
  });
});

// --- Scope and wording, zero-key -------------------------------------------

describe('the exercise itself is scoped to the band, with no model configured', () => {
  it('records the band and the scope it used', async () => {
    const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'emerging' });
    expect(sample.band).toBe('emerging');
    expect(sample.scope).toBe('artifact');
  });

  it('never asks an emerging candidate to arbitrate an organisation-wide decision', async () => {
    for (const band of CRAFT_BANDS) {
      const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band });
      for (const re of ORG_LANGUAGE) {
        expect(re.test(sample.prompt), `${band}: ${sample.prompt}`).toBe(false);
      }
    }
  });

  it('never asks a principal to write a loop', async () => {
    for (const band of ORG_BANDS) {
      const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band });
      for (const re of LINE_LEVEL_LANGUAGE) {
        expect(re.test(sample.prompt), `${band}: ${sample.prompt}`).toBe(false);
      }
    }
  });

  it('scopes an emerging exercise to one concrete thing', async () => {
    const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'emerging' });
    expect(sample.prompt.toLowerCase()).toMatch(/\b(a single|one|just the)\b/);
  });

  it('scopes a principal exercise to the organisation around the work', async () => {
    const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'principal' });
    expect(sample.prompt.toLowerCase()).toMatch(/team|platform|standard|trade-off|organisation/);
  });

  it('produces visibly different exercises for emerging and principal on one competency', async () => {
    const junior = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'emerging' });
    const principal = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'principal' });
    expect(junior.prompt).not.toBe(principal.prompt);
    expect(junior.scope).not.toBe(principal.scope);
  });

  it('keeps the zero-key exercise short, typeable and on-competency at every band', async () => {
    for (const band of ALL_BANDS) {
      const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band });
      expect(sample.prompt.startsWith(WORK_SAMPLE_LEAD_IN), band).toBe(true);
      expect(sample.prompt, band).toContain(PIPELINES.name);
      expect(sample.prompt.toLowerCase(), band).toContain('type your answer');
      expect(sample.prompt.length, `${band}: ${sample.prompt.length}`).toBeLessThan(800);
    }
  });

  it('scopes the coding exercise to the band rather than dropping it', async () => {
    const junior = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'emerging', block: codingBlock() });
    const principal = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'principal', block: codingBlock() });
    expect(junior.form).toBe('coding');
    expect(principal.form).toBe('coding');
    expect(junior.prompt).not.toBe(principal.prompt);
    for (const re of LINE_LEVEL_LANGUAGE) {
      expect(re.test(principal.prompt), principal.prompt).toBe(false);
    }
  });

  it('still works with no band at all', async () => {
    const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE });
    expect(sample.prompt.startsWith(WORK_SAMPLE_LEAD_IN)).toBe(true);
    expect(sample.prompt).toContain(PIPELINES.name);
  });
});

function codingBlock() {
  return {
    competencyId: PIPELINES.id, competencyName: PIPELINES.name, intent: 'x',
    targetMinutes: 6, followupHints: [], prohibited: [], module: 'coding' as const,
  };
}

// --- What the model is told -------------------------------------------------

describe('the model is told the band', () => {
  it('carries the band guidance verbatim into the work-sample prompt', async () => {
    script.mode = 'ok';
    script.prompt = 'Here is a small nightly load that reruns from scratch each night. What would you check first?';
    await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'emerging', sessionId: 's1' });

    const user = script.seen.at(-1)?.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain(bandGuidanceFor('emerging'));
  });

  it('names the abstraction and the scope the exercise must sit at', async () => {
    script.mode = 'ok';
    script.prompt = 'A proposal lands to standardise ingestion on one framework. What are the strongest objections?';
    await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'principal', sessionId: 's2' });

    const user = script.seen.at(-1)?.find((m) => m.role === 'user')?.content ?? '';
    expect(user.toLowerCase()).toContain('organisation');
    expect(user).toMatch(/scope/i);
  });

  it('asks for different scopes for a graduate and a principal', async () => {
    script.mode = 'ok';
    script.prompt = 'A small exercise that is fine at any level, phrased neutrally for the test.';
    await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'emerging', sessionId: 's3' });
    const junior = script.seen.at(-1)?.find((m) => m.role === 'user')?.content ?? '';
    await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'principal', sessionId: 's4' });
    const principal = script.seen.at(-1)?.find((m) => m.role === 'user')?.content ?? '';
    expect(junior).not.toBe(principal);
  });
});

// --- The gate ---------------------------------------------------------------

describe('a band-inappropriate work sample is refused with a reason', () => {
  const ORG_EXERCISE =
    'Two directors disagree on a build-versus-buy decision for the ingestion platform, with headcount and budget ' +
    'already committed across three teams. Which way do you rule, and what do you tell the one you overrule?';

  it('names the reason an exercise is wrong for the band', () => {
    expect(workSampleBlockReason(ORG_EXERCISE, 'emerging')).toBeTruthy();
    expect(workSampleBlockReason(ORG_EXERCISE, 'principal')).toBeNull();
  });

  it('refuses a model exercise that presumes authority the candidate never held', async () => {
    script.mode = 'ok';
    script.prompt = ORG_EXERCISE;
    const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'emerging', sessionId: 's5' });

    expect(sample.blockedReason, 'the refusal must be surfaced, not silent').toBeTruthy();
    expect(sample.prompt).not.toContain('build-versus-buy');
    // ...and the candidate still gets a usable exercise rather than a dead turn.
    expect(sample.prompt.startsWith(WORK_SAMPLE_LEAD_IN)).toBe(true);
    expect(sample.prompt).toContain(PIPELINES.name);
  });

  it('lets the same exercise through for the band that can answer it', async () => {
    script.mode = 'ok';
    script.prompt = ORG_EXERCISE;
    const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'principal', sessionId: 's6' });
    expect(sample.blockedReason).toBeNull();
    expect(sample.prompt).toContain('build-versus-buy');
  });

  it('does not over-block a band-appropriate model exercise', async () => {
    script.mode = 'ok';
    script.prompt = 'Here is a nightly load someone wrote that reruns everything from scratch. What would you change first?';
    const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band: 'emerging', sessionId: 's7' });
    expect(sample.blockedReason).toBeNull();
    expect(sample.prompt).toContain('reruns everything from scratch');
  });

  it('never produces a zero-key exercise its own band would refuse', async () => {
    for (const band of ALL_BANDS) {
      for (const module of [undefined, 'coding' as const]) {
        const block = module === 'coding' ? codingBlock() : undefined;
        const sample = await buildWorkSample({ competency: PIPELINES, role: ROLE, band, block });
        expect(workSampleBlockReason(sample.prompt, band), `${band}/${module}: ${sample.prompt}`).toBeNull();
        expect(sample.blockedReason, `${band}/${module}`).toBeNull();
      }
    }
  });
});
