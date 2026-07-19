import type { Competency, PlanBlock, RoleSuccessProfile, TurnRecord } from '../domain/types.js';
import { generateJson } from '../providers/llm/index.js';

// Work samples (BRD evidence mode `work_sample`).
//
// The operator's framing: "understand who you ask coding questions and who you
// do not. that should be common sense." A Salesforce Administrator asked to
// write a Python function learns that the interviewer does not know what the
// job is. So eligibility and FORM are both derived from the competency itself —
// its category, its declared evidence modes, and (via the LLM) its name and
// definition — never from a global "coding round on/off" switch.
//
// The artefact is deliberately tiny. This is a first-round screen, answerable
// in two or three minutes by voice or by typing into the interview room's text
// mode. It is not a take-home.

/**
 * The shape of the artefact, not its subject matter. The subject comes from the
 * competency. `coding` is the only form that presumes source code, and it is
 * only ever reachable when an operator explicitly configured a coding module.
 */
export type WorkSampleForm = 'artifact_review' | 'diagnostic' | 'critique' | 'design_sketch' | 'coding';

export interface WorkSample {
  form: WorkSampleForm;
  competencyId: string;
  prompt: string;
}

/**
 * Stable lead-in prepended to every work sample, whatever produced its body.
 *
 * It is the marker that lets us recognise our own past work samples in a
 * transcript. Turn records carry only text and a competency id, so there is
 * nowhere else to record "this turn was a work sample" — and classifying LLM
 * prose after the fact would be guesswork. Because we prepend this ourselves,
 * outside anything the model writes, detection stays exact.
 */
export const WORK_SAMPLE_LEAD_IN = 'Let\'s do a short practical one.';

/** Told to the candidate every time, because the text mode is easy to forget exists. */
const ANSWER_MODE_HINT =
  ' Two or three minutes is plenty — and you can type your answer if that\'s easier than saying it out loud.';

/** No more than this many per interview; it is a screen, not an exam. */
const MAX_WORK_SAMPLES_PER_INTERVIEW = 2;

/** Categories that describe how a person behaves, not what they can produce. */
const NEVER_ELIGIBLE: ReadonlyArray<Competency['category']> = ['behavioral', 'communication'];

/**
 * Can this competency carry a work sample at all?
 *
 * A behavioural or communication competency never can: there is no artefact to
 * review, and handing someone a puzzle to prove they collaborate well is a
 * category error.
 *
 * For the rest we trust the competency's own `evidenceModes` when they say
 * something useful, and fall back to category for `technical`. The fallback
 * matters because the LLM extraction path in roleIntelligence emits
 * `['behavioral_example', 'technical_explanation']` for everything — without it,
 * LLM-extracted roles would silently never get a work sample.
 */
export function isWorkSampleEligible(c: Competency): boolean {
  if (NEVER_ELIGIBLE.includes(c.category)) return false;
  const modes = c.evidenceModes ?? [];
  if (modes.includes('work_sample') || modes.includes('case')) return true;
  return c.category === 'technical';
}

/**
 * Pick the artefact shape. Deterministic per competency so two competencies in
 * the same interview do not both get "here's a thing, what breaks" — the
 * monotony this whole change exists to remove applies to work samples too.
 */
export function workSampleFormFor(c: Competency, module?: PlanBlock['module']): WorkSampleForm {
  // Only an explicit operator decision can produce a code artefact.
  if (module === 'coding') return 'coding';
  const rotation: WorkSampleForm[] =
    c.category === 'situational'
      ? ['diagnostic', 'critique', 'design_sketch']
      : ['artifact_review', 'diagnostic', 'design_sketch', 'critique'];
  let hash = 0;
  for (const ch of c.id || c.name) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return rotation[hash % rotation.length];
}

/** How many work samples this interview has already put to the candidate. */
export function countWorkSamples(turns: TurnRecord[]): number {
  return turns.filter((t) => t.speaker === 'agent' && t.text.includes(WORK_SAMPLE_LEAD_IN)).length;
}

/** Has this specific competency already been given one? */
function offeredForCompetency(turns: TurnRecord[], competencyId: string): boolean {
  return turns.some(
    (t) => t.speaker === 'agent' && t.competencyId === competencyId && t.text.includes(WORK_SAMPLE_LEAD_IN),
  );
}

/**
 * Whether the next utterance should be a work sample.
 *
 * Never opens a block: the candidate talks about the area first, and the
 * artefact then makes concrete what they have just claimed in the abstract.
 * Opening cold with a puzzle reads as a test, which is exactly the tone that
 * lost the real candidate.
 */
export function shouldOfferWorkSample(opts: {
  competency: Competency | undefined;
  turns: TurnRecord[];
  answersHere: number;
  action: 'ask' | 'followup' | 'move_on' | 'close';
}): boolean {
  const { competency, turns, answersHere, action } = opts;
  if (!competency || action === 'close') return false;
  if (!isWorkSampleEligible(competency)) return false;
  if (answersHere < 1) return false;
  if (offeredForCompetency(turns, competency.id)) return false;
  return countWorkSamples(turns) < MAX_WORK_SAMPLES_PER_INTERVIEW;
}

/**
 * Build the artefact. The LLM is asked to invent something in the competency's
 * OWN domain — that is the whole point, and why the prompt refuses to name a
 * language. With no key configured the heuristic templates below take over;
 * they are deliberately domain-agnostic (a "configuration that falls over at
 * production volume" is a Flow for an admin, a DAG for a data engineer) so the
 * zero-key path is never wrong about the role, only less specific.
 */
export async function buildWorkSample(opts: {
  competency: Competency;
  block?: PlanBlock;
  role?: RoleSuccessProfile;
  sessionId?: string;
}): Promise<WorkSample> {
  const { competency, block, role, sessionId } = opts;
  const form = workSampleFormFor(competency, block?.module);
  const llm = await tryLlmWorkSample(competency, form, role, sessionId);
  const body = llm ?? heuristicBody(competency.name, form);
  return {
    form,
    competencyId: competency.id,
    prompt: `${WORK_SAMPLE_LEAD_IN} ${body}${ANSWER_MODE_HINT}`,
  };
}

async function tryLlmWorkSample(
  competency: Competency,
  form: WorkSampleForm,
  role: RoleSuccessProfile | undefined,
  sessionId: string | undefined,
): Promise<string | null> {
  const result = await generateJson<{ prompt: string }>({
    fn: 'work_sample',
    sessionId,
    temperature: 0.5,
    system:
      'You write tiny work-sample exercises for a first-round job screen. ' +
      'Infer the correct kind of artefact from the competency name and definition alone. ' +
      'The artefact MUST belong to that competency\'s own domain: a Salesforce administrator competency gets ' +
      'a Flow description, a SOQL query or a sharing model — never a Python function; a finance competency gets ' +
      'a reconciliation or a forecast assumption; a marketing competency gets a campaign or an attribution model. ' +
      'NEVER assume the candidate writes code unless the competency itself is about writing code. ' +
      'Keep it answerable in 2-3 minutes, spoken aloud or typed: describe the artefact in 2-3 sentences, ' +
      'then ask ONE question about it. No preamble, no rubric, no scoring hints. ' +
      'Output JSON: {"prompt": "..."}.',
    user:
      `Competency: ${competency.name}\n` +
      `Definition: ${competency.definition}\n` +
      `Category: ${competency.category}\n` +
      `Role context: ${role?.roleContext ?? '(unknown)'}\n` +
      `Seniority: ${role?.seniority ?? '(unknown)'}\n` +
      `Required artefact shape: ${formBrief(form)}\n` +
      'Write the exercise.',
    validate: (raw: unknown) => {
      const r = raw as { prompt?: unknown };
      if (typeof r?.prompt !== 'string' || r.prompt.length < 20) throw new Error('bad work sample');
      return { prompt: r.prompt.slice(0, 900) };
    },
  });
  return result?.prompt ?? null;
}

function formBrief(form: WorkSampleForm): string {
  switch (form) {
    case 'artifact_review':
      return 'show them a small artefact built by someone else and ask what breaks under real-world load or scale';
    case 'diagnostic':
      return 'give them a symptom with no obvious cause and ask what they check first and what each answer rules out';
    case 'critique':
      return 'state an approach someone proposed and ask for the strongest objections to it';
    case 'design_sketch':
      return 'give a small requirement and ask them to sketch a structure and name where it gets fragile';
    case 'coding':
      return 'a very small code-reading exercise: show a short snippet and ask what is wrong with it';
  }
}

/**
 * Zero-key fallbacks. Parameterised by competency name only — there is no
 * language list and no technology list here, because guessing a stack is the
 * failure mode this module exists to prevent.
 */
function heuristicBody(name: string, form: WorkSampleForm): string {
  switch (form) {
    case 'artifact_review':
      return (
        `Picture this: I hand you a ${name} setup that someone else built and then left. ` +
        'It reviews cleanly and works fine on a handful of records, and the first time it runs against ' +
        'real production volume it falls over. What are the two things you\'d suspect first, and how would ' +
        'you tell which one it actually is?'
      );
    case 'diagnostic':
      return (
        `Something in your ${name} area worked yesterday and is failing today, and nothing was deployed in between. ` +
        'Talk me through your first five minutes: what do you look at, in what order, and what does each answer rule out?'
      );
    case 'critique':
      return (
        `Someone on your team proposes handling a ${name} requirement with the simplest thing that works, ` +
        'and cleaning it up later. Give me the two strongest objections you\'d raise — and the one situation ' +
        'where you\'d let it through anyway.'
      );
    case 'design_sketch':
      // Deliberately states the requirement in terms of change and exceptions
      // rather than any particular mechanism — naming one (access, schema,
      // scheduling) would guess at the domain, which is the error this module
      // exists to avoid.
      return (
        `Sketch me a small ${name} design. The requirement is simple on day one, then two things happen: ` +
        'the volume grows by an order of magnitude, and a second group of users turns up needing the same ' +
        'thing with one exception. What\'s your structure, and which part of it gets fragile first?'
      );
    case 'coding':
      return (
        `I'll describe a short piece of ${name} logic rather than make you write any: it loops over a collection ` +
        'and performs one lookup and one write per item. Tell me what goes wrong with it at scale, and what you\'d change.'
      );
  }
}
