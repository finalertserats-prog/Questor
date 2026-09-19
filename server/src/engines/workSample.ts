import type { Competency, PlanBlock, RoleSuccessProfile, TurnRecord } from '../domain/types.js';
import { generateJson } from '../providers/llm/index.js';
import { bandById, type Abstraction, type BandId } from './experienceBands.js';
import { bandGuidanceFor, templateAllowedForBand, templateBlockReason } from './bandCalibration.js';

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
//
// WHAT is asked is the competency's job. At WHAT LEVEL is the band's.
//
// Until the band reached this module, it did not have one. A tri-model review
// scored the interview well on calibration everywhere except here: a graduate
// and a principal engineer were handed exercises of the same shape and the same
// scope, because this file consulted the competency and nothing else — while the
// planner, the template bank and the follow-up ladder had all been pitched at the
// candidate's band for some time. The band now decides two things: which FORM the
// exercise takes, and the SCOPE of what it puts in front of the candidate.

/**
 * The shape of the artefact, not its subject matter. The subject comes from the
 * competency. `coding` is the only form that presumes source code, and it is
 * only ever reachable when an operator explicitly configured a coding module.
 */
export type WorkSampleForm = 'artifact_review' | 'diagnostic' | 'critique' | 'design_sketch' | 'coding';

/**
 * How much of the world the exercise puts in front of the candidate.
 *
 * One axis, mirroring `Abstraction`, because the thing that actually changes
 * with experience is not the difficulty of the artefact but its size: a single
 * query, a subsystem you own, or a decision that outlives both.
 */
export type WorkSampleScope = 'artifact' | 'subsystem' | 'organisation';

export interface WorkSample {
  form: WorkSampleForm;
  competencyId: string;
  prompt: string;
  /** The band this exercise was calibrated for, or undefined if none was resolved. */
  band?: BandId;
  scope: WorkSampleScope;
  /**
   * Set when a generated exercise was refused as wrong for the band and the
   * calibrated fallback was used instead. Recorded rather than swallowed: a
   * silent substitution looks identical to the model simply behaving, and the
   * band guard is exactly the thing we need to be able to audit.
   */
  blockedReason: string | null;
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

/** The band's abstraction, rendered as the size of thing we hand the candidate. */
const SCOPE_BY_ABSTRACTION: Record<Abstraction, WorkSampleScope> = {
  craft: 'artifact',
  system: 'subsystem',
  organisation: 'organisation',
};

/**
 * Which artefact shapes are honest to put to each abstraction.
 *
 * Craft bands get the two forms that can be answered from something the
 * candidate has personally touched — here is a thing, what breaks; here is a
 * symptom, what do you check. `design_sketch` and `critique` are withheld from
 * them for the same reason the template bank withholds the inherited-system
 * question: both presume a seat at a table an emerging candidate has never sat
 * at, and asking anyway produces a confident guess we would then score.
 *
 * Organisation bands get the inverse. Handing a principal a small artefact and
 * asking what breaks is answerable — it is simply not evidence about them, and
 * it reads as a test of whether they still remember how. What discriminates at
 * that level is the trade-off: which of two defensible options, and what it
 * costs the people who have to live with it.
 *
 * System bands keep the full spread; the middle of the scale is where every
 * form is legitimate.
 */
const FORMS_BY_ABSTRACTION: Record<Abstraction, readonly WorkSampleForm[]> = {
  craft: ['artifact_review', 'diagnostic'],
  system: ['artifact_review', 'diagnostic', 'design_sketch', 'critique'],
  organisation: ['critique', 'design_sketch'],
};

/**
 * The scope with no band resolved. The middle, matching `bandForRoleSeniority`'s
 * own fallback: an unknown level is missing information, and the least damaging
 * place to stand when you do not know is the middle of the scale.
 */
const DEFAULT_SCOPE: WorkSampleScope = 'subsystem';

export function workSampleScopeForBand(bandId: BandId): WorkSampleScope {
  return SCOPE_BY_ABSTRACTION[bandById(bandId).abstraction];
}

export function workSampleFormsForBand(bandId: BandId): WorkSampleForm[] {
  return [...FORMS_BY_ABSTRACTION[bandById(bandId).abstraction]];
}

/**
 * Pick the artefact shape. Deterministic per competency so two competencies in
 * the same interview do not both get "here's a thing, what breaks" — the
 * monotony this whole change exists to remove applies to work samples too.
 *
 * The competency's category proposes an order; the band decides which of those
 * proposals are legal. Intersecting rather than replacing keeps the category's
 * preference visible where the two agree — a situational competency still leads
 * with `diagnostic` at every band that allows one.
 */
export function workSampleFormFor(c: Competency, module?: PlanBlock['module'], bandId?: BandId): WorkSampleForm {
  // Only an explicit operator decision can produce a code artefact — and that
  // decision is about the job, not the candidate, so the band scopes the code
  // exercise rather than cancelling it.
  if (module === 'coding') return 'coding';

  const byCategory: WorkSampleForm[] =
    c.category === 'situational'
      ? ['diagnostic', 'critique', 'design_sketch']
      : ['artifact_review', 'diagnostic', 'design_sketch', 'critique'];

  const rotation = bandId ? narrowToBand(byCategory, bandId) : byCategory;
  let hash = 0;
  for (const ch of c.id || c.name) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return rotation[hash % rotation.length];
}

/**
 * The category's rotation, minus anything the band cannot carry.
 *
 * Falls back to the band's own list rather than to the category's when the two
 * share nothing. The band is the harder constraint: an exercise of a shape the
 * competency did not suggest is merely a slightly odd fit, whereas one pitched
 * at a level the candidate has never worked at cannot be answered honestly.
 */
function narrowToBand(byCategory: WorkSampleForm[], bandId: BandId): WorkSampleForm[] {
  const allowed = FORMS_BY_ABSTRACTION[bandById(bandId).abstraction];
  const both = byCategory.filter((f) => allowed.includes(f));
  return both.length > 0 ? both : [...allowed];
}

/**
 * Exercises too hands-on to put to someone whose work is organisational.
 *
 * `templateAllowedForBand` deliberately has no ceiling — a basic QUESTION asked
 * of an executive wastes a turn but is answerable. A work sample is different:
 * it is the one moment in the interview where we hand someone a task, and
 * handing a principal a loop to trace is not a wasted turn, it is a statement
 * about what we think they are. So work samples get the ceiling that questions
 * do not.
 */
const LINE_LEVEL_FLOORS: Array<{ re: RegExp; why: string }> = [
  { re: /\bwrite (a|the) (loop|function|method|script|query)\b/i, why: 'asks for line-level code from a candidate whose work sits at the organisation level' },
  { re: /\bloops over\b/i, why: 'puts a line-level construct in front of a candidate whose work sits at the organisation level' },
  { re: /\bline of code\b/i, why: 'reduces an organisation-level candidate to a line-level exercise' },
  { re: /\bsyntax\b/i, why: 'treats decades of judgement as a syntax check' },
];

/**
 * Why this exercise is wrong for this band, or null if it is fine.
 *
 * Reuses the template gate so a work sample and a question are screened by one
 * rule — the floors were written against question text, but the thing they
 * detect (presumed ownership, presumed authority) reads identically in an
 * exercise — and adds the ceiling above.
 */
export function workSampleBlockReason(text: string, bandId: BandId): string | null {
  const floor = templateBlockReason(text, bandId);
  if (floor) return floor;
  if (bandById(bandId).abstraction === 'organisation') {
    for (const rule of LINE_LEVEL_FLOORS) if (rule.re.test(text)) return rule.why;
  }
  return null;
}

/** Is this exercise fair to put to someone at this band? */
export function workSampleAllowedForBand(text: string, bandId: BandId): boolean {
  return templateAllowedForBand(text, bandId) && workSampleBlockReason(text, bandId) === null;
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
  /** The band the rest of the interview is pitched at (`InterviewPlan.band`). */
  band?: BandId;
}): Promise<WorkSample> {
  const { competency, block, role, sessionId, band } = opts;
  const form = workSampleFormFor(competency, block?.module, band);
  const scope = band ? workSampleScopeForBand(band) : DEFAULT_SCOPE;
  const calibrated = heuristicBody(competency.name, form, scope);

  const llm = await tryLlmWorkSample({ competency, form, scope, band, role, sessionId });

  // Screen what the model wrote before it is asked, not after. The model is
  // where the miscalibration came from for questions, and there is no reason to
  // expect exercises to behave better — it is given the band and still has to
  // be held to it.
  const refusal = llm && band ? workSampleBlockReason(llm, band) : null;
  const body = llm && !refusal ? llm : calibrated;

  return {
    form,
    competencyId: competency.id,
    band,
    scope,
    blockedReason: refusal,
    prompt: `${WORK_SAMPLE_LEAD_IN} ${body}${ANSWER_MODE_HINT}`,
  };
}

async function tryLlmWorkSample(opts: {
  competency: Competency;
  form: WorkSampleForm;
  scope: WorkSampleScope;
  band: BandId | undefined;
  role: RoleSuccessProfile | undefined;
  sessionId: string | undefined;
}): Promise<string | null> {
  const { competency, form, scope, band, role, sessionId } = opts;
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
      'The exercise must also match the candidate\'s LEVEL: pitch it at the stated scope exactly. ' +
      'Do not ask someone whose work is organisational to trace a loop or recall syntax, ' +
      'and do not ask someone at the start of their career to arbitrate a decision across teams, ' +
      'a budget or a platform bet — they have never held that authority and can only guess. ' +
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
      `Required scope: ${scopeBrief(scope)}\n` +
      `Expected answer shape: ${answerShape(scope)}\n` +
      (band ? `${bandGuidanceFor(band)}\n` : '') +
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
      return 'a code-reading exercise, never a code-writing one: describe the logic and ask what is wrong with it';
  }
}

/** How much of the world the exercise is allowed to put in front of them. */
function scopeBrief(scope: WorkSampleScope): string {
  switch (scope) {
    case 'artifact':
      return 'one concrete thing they could have built or touched themselves — a single step, query, screen, record or document. Nothing that spans a system, and nothing they would need to have owned something to answer';
    case 'subsystem':
      return 'a subsystem someone could own end to end, including how it fails and what it costs to run';
    case 'organisation':
      return 'a decision that spans teams or outlives any one system — a standard to set, a platform bet, a trade-off between two defensible options and who has to live with it';
  }
}

/** What a complete answer to an exercise at this scope actually looks like. */
function answerShape(scope: WorkSampleScope): string {
  switch (scope) {
    case 'artifact':
      return 'a concrete first move and the reasoning behind it — what they would check, in what order, and what each answer rules out';
    case 'subsystem':
      return 'the failure modes, the trade-off they would choose, and how they would know it worked';
    case 'organisation':
      return 'the bet, the option they would reject and why, and the second-order cost they would accept';
  }
}

/**
 * Zero-key fallbacks, one per form and scope.
 *
 * Parameterised by competency name only — there is no language list and no
 * technology list here, because guessing a stack is the failure mode this module
 * exists to prevent. The scope axis is the second half of that discipline: the
 * zero-key path is allowed to be less specific about the DOMAIN than the model,
 * but it is not allowed to be wrong about the LEVEL, because with no key
 * configured this text is the whole exercise.
 *
 * Every string here is asserted to pass `workSampleBlockReason` for the band
 * that can reach it — the fallback for a refused exercise must not itself be
 * refusable.
 */
function heuristicBody(name: string, form: WorkSampleForm, scope: WorkSampleScope): string {
  switch (form) {
    case 'artifact_review':
      switch (scope) {
        case 'artifact':
          return (
            `Picture a single ${name} step that you built yourself. It works on a handful of records, ` +
            'and the first time it runs against real data it falls over. What are the two things you\'d ' +
            'suspect first, and how would you tell which one it actually is?'
          );
        case 'subsystem':
          return (
            `Picture this: I hand you a ${name} setup that someone else built and then left. ` +
            'It reviews cleanly and works fine on a handful of records, and the first time it runs against ' +
            'real production volume it falls over. What are the two things you\'d suspect first, and how would ' +
            'you tell which one it actually is?'
          );
        case 'organisation':
          return (
            `Two teams have each built their own ${name} capability, and both are defensible on their own terms. ` +
            'What\'s the trade-off you\'d make to get to one of them — and which part would you deliberately ' +
            'leave duplicated rather than pay to unify?'
          );
      }
      break;
    case 'diagnostic':
      switch (scope) {
        case 'artifact':
          return (
            `Something in your ${name} work ran fine yesterday and is failing today, and nothing changed in between. ` +
            'Talk me through your first five minutes on just the one thing in front of you: what do you look at, ' +
            'in what order, and what does each answer rule out?'
          );
        case 'subsystem':
          return (
            `Something in your ${name} area worked yesterday and is failing today, and nothing was deployed in between. ` +
            'Talk me through your first five minutes: what do you look at, in what order, and what does each answer rule out?'
          );
        case 'organisation':
          return (
            `Your ${name} area has had three unrelated-looking failures this quarter. Never mind the individual fixes — ` +
            'what would you look for across them, and what would you change about how the organisation works ' +
            'if the pattern turns out to be real?'
          );
      }
      break;
    case 'critique':
      switch (scope) {
        case 'artifact':
          return (
            `Someone on your team wants to handle one ${name} requirement with the quickest thing that works ` +
            'and tidy it up later. Give me the two strongest objections you\'d raise — and the one situation ' +
            'where you\'d let it through anyway.'
          );
        case 'subsystem':
          return (
            `Someone on your team proposes handling a ${name} requirement with the simplest thing that works, ` +
            'and cleaning it up later. Give me the two strongest objections you\'d raise — and the one situation ' +
            'where you\'d let it through anyway.'
          );
        case 'organisation':
          return (
            `A proposal lands to standardise ${name} on one approach for everyone, with the teams already doing it ` +
            'differently given a quarter to migrate. Make the strongest case against it — and tell me what would ' +
            'have to be true before you\'d back it anyway.'
          );
      }
      break;
    case 'design_sketch':
      // Deliberately states the requirement in terms of change and exceptions
      // rather than any particular mechanism — naming one (access, schema,
      // scheduling) would guess at the domain, which is the error this module
      // exists to avoid.
      switch (scope) {
        case 'artifact':
          return (
            `Sketch me one small piece of a ${name} design — just the part you'd build first. It's simple on day one, ` +
            'then the volume grows and a second group of users turns up needing the same thing with one exception. ' +
            'What\'s your structure, and which part of it gets fragile first?'
          );
        case 'subsystem':
          return (
            `Sketch me a small ${name} design. The requirement is simple on day one, then two things happen: ` +
            'the volume grows by an order of magnitude, and a second group of users turns up needing the same ' +
            'thing with one exception. What\'s your structure, and which part of it gets fragile first?'
          );
        case 'organisation':
          return (
            `Sketch the ${name} direction you'd set for the next three years, given two teams already heading ` +
            'different ways. What\'s the shape you\'d standardise on, what would you let stay different, and ' +
            'which part of that bet is most likely to be the one you got wrong?'
          );
      }
      break;
    case 'coding':
      // An explicit operator opt-in, so the exercise happens at every band —
      // but reading a snippet is a craft-level act, and at the organisation
      // level the same code becomes a question about the standard behind it.
      switch (scope) {
        case 'artifact':
          return (
            `I'll describe a short piece of ${name} logic rather than make you write any: it loops over a collection ` +
            'and does one lookup and one write per item. Tell me what goes wrong with it as the collection grows, ' +
            'and what you\'d change.'
          );
        case 'subsystem':
          return (
            `I'll describe a piece of ${name} logic rather than make you write any: it loops over a collection and ` +
            'does one lookup and one write per item, and it now sits on the critical path of a service you own. ' +
            'What goes wrong at production volume, what would you change, and what would you measure to know it worked?'
          );
        case 'organisation':
          return (
            `Rather than have you read a snippet: the same ${name} pattern — a per-item lookup and write inside a ` +
            'loop — keeps reappearing in review. What standard would you set so it stops recurring, and what does ' +
            'that standard cost the people who have to follow it?'
          );
      }
      break;
  }
  // Unreachable: both switches are exhaustive over their union types.
  return `Tell me about a piece of ${name} work you'd point to, and what you'd change about it now.`;
}
