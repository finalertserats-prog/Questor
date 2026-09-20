import { z } from 'zod';
import type { AssessmentResult, Competency, CompetencyScore, RoleSuccessProfile } from '../domain/types.js';
import { lintJd } from '../engines/jdDraft.js';
import { screenQuestion, validateNoProtectedInference } from '../engines/policyEngine.js';

/**
 * The candidate's feedback letter: an at-a-glance row per competency, a SWOT,
 * what the role asks against what we heard, and three next steps (the design
 * the owner approved). Pure, so every rule is tested on its own
 * (tests/feedbackContentModel.test.ts); services/autoFeedbackContent.ts asks
 * the model, providers/email/autoFeedbackEmail.ts renders it, and
 * services/autoFeedback.ts sends it.
 *
 * Nobody need read this before the candidate does, so the guardrails carry the
 * weight a reviewer would:
 *
 *   - THE FACTS ARE OURS. Which competencies exist, how each was covered, and
 *     the candidate's quoted words come from the assessment and the scorecard.
 *     The model only ever writes prose around them, so it cannot invent a
 *     competency, a quote or a coverage marker.
 *   - NO SCORE, LEVEL, RATING, RECOMMENDATION, PASS/FAIL, RANKING, WEIGHTING,
 *     COMPARISON, DECISION OR PROMISE, in any field. The four-segment bar in
 *     the email is drawn from the marker, which is a word, not a number.
 *   - A COMPETENCY WITH NO EVIDENCE IS "NOT COVERED", never a shortfall: the
 *     conversation ran out of time, which is ours to own, not theirs.
 *   - Nothing about protected characteristics, and no exclusionary wording,
 *     including inside a quote.
 *
 * Anything that fails falls back: model wording, then wording built from the
 * evidence, then safe generic wording that asserts nothing about the person.
 */

export type CoverageMarker = 'strength' | 'partly' | 'not-covered';

export const MARKER_LABEL: Readonly<Record<CoverageMarker, string>> = {
  strength: 'Clear strength',
  partly: 'Partly shown',
  'not-covered': 'Not covered',
};

/** Filled segments of the four in the glance bar. Qualitative: three buckets, no scale. */
export const MARKER_SEGMENTS: Readonly<Record<CoverageMarker, number>> = {
  strength: 3,
  partly: 2,
  'not-covered': 0,
};

export interface FeedbackCompetency {
  readonly id: string;
  readonly name: string;
  readonly marker: CoverageMarker;
  /** From the scorecard the role was approved with — the employer's own words. */
  readonly roleAsks: string;
  readonly whatWeHeard: string;
  /** The candidate's own words from the transcript; empty when it never came up. */
  readonly quote: string;
  readonly toGoFurther: string;
}

export interface FeedbackSwot {
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly opportunities: readonly string[];
  readonly watchOuts: readonly string[];
}

export interface FeedbackContent {
  readonly swot: FeedbackSwot;
  readonly competencies: readonly FeedbackCompetency[];
  readonly nextSteps: readonly string[];
}

export type FeedbackContentSource = 'model' | 'evidence' | 'generic';

export interface FeedbackInput {
  readonly result: AssessmentResult;
  /** The approved scorecard, for what the role asks. Null when it cannot be read. */
  readonly profile: RoleSuccessProfile | null;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

const bullet = z.string().trim().min(15).max(300);
const line = z.string().trim().min(10).max(400);

const swotSchema = z.object({
  strengths: z.array(bullet).min(2).max(3),
  weaknesses: z.array(bullet).min(2).max(3),
  opportunities: z.array(bullet).min(2).max(3),
  watchOuts: z.array(bullet).min(2).max(3),
}).strict();

export const feedbackContentSchema = z.object({
  swot: swotSchema,
  competencies: z.array(z.object({
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    marker: z.enum(['strength', 'partly', 'not-covered']),
    roleAsks: line,
    whatWeHeard: line,
    quote: z.string().max(600),
    toGoFurther: line,
  }).strict()).min(1).max(12),
  nextSteps: z.array(line).min(2).max(3),
}).strict();

/** What the model may contribute: prose only, keyed to competencies we already know. */
export const modelFeedbackSchema = z.object({
  swot: swotSchema,
  notes: z.array(z.object({
    competencyId: z.string().min(1).max(200),
    whatWeHeard: line,
    toGoFurther: line,
  }).strict()).max(12),
  nextSteps: z.array(line).min(2).max(3),
}).strict();

export type ModelFeedback = z.infer<typeof modelFeedbackSchema>;

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

const MAX_COMPETENCIES = 8;
/** Long enough to be recognisable, short enough to read as a quote. */
const MAX_QUOTE_CHARS = 220;

function hasEvidence(c: CompetencyScore): boolean {
  return Array.isArray(c.evidence) && c.evidence.some((e) => Boolean(e.quote?.trim()));
}

/**
 * How the conversation went on this competency, in three buckets.
 *
 * `gradingUnavailable` counts as not covered even when a level survives on the
 * row: that flag means our rubric call failed, which is a fact about our
 * system and not about the person.
 */
export function coverageMarker(c: CompetencyScore): CoverageMarker {
  if (c.notEnoughEvidence || c.level === null || c.gradingUnavailable || !hasEvidence(c)) return 'not-covered';
  return c.level >= c.requiredLevel ? 'strength' : 'partly';
}

function trimQuote(quote: string): string {
  const clean = quote.replace(/\s+/g, ' ').replace(/["“”]/g, "'").trim();
  if (clean.length <= MAX_QUOTE_CHARS) return clean;
  const cut = clean.slice(0, MAX_QUOTE_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The first of the candidate's own words for this competency that can be put
 * in front of them, or nothing.
 *
 * Their words are theirs, but "I passed with 90%" or "they put me at level 5"
 * quoted back in a letter that otherwise carries no number reads as our
 * verdict on them. A quote that trips the same checks as our prose is passed
 * over for the next one, and the row is simply left out when none is clean.
 */
function firstQuote(c: CompetencyScore, used: Set<string>): string {
  for (const span of c.evidence ?? []) {
    const quote = span.quote?.trim() ? trimQuote(span.quote) : '';
    if (!quote || used.has(quote) || verdictChecks(quote).length > 0) continue;
    used.add(quote);
    return quote;
  }
  return '';
}

/** How a competency is described when the scorecard's own words cannot be used. */
function plainRoleAsks(name: string): string {
  return `Showing ${name} in the work you do day to day.`;
}

/**
 * What the role asks, in the employer's own words from the approved scorecard.
 *
 * A job description is about the job, but it can still say "Level 5" or
 * "shortlist criterion", and in this letter that reads as a mark against the
 * person. Wording that trips the checks is replaced by the plain form rather
 * than shown or dropped.
 */
function roleAsksFor(name: string, defined: Competency | undefined): string {
  const definition = defined?.definition?.trim() ?? '';
  const indicator = defined?.indicators?.find((i) => i.trim().length >= 10)?.trim() ?? '';
  const candidate = definition.length >= 10 ? definition : indicator;
  if (!candidate) return plainRoleAsks(name);
  return verdictChecks(candidate).length > 0 ? plainRoleAsks(name) : candidate;
}

const HEARD_TEMPLATES: Readonly<Record<CoverageMarker, (name: string) => string>> = {
  strength: () => 'You gave a specific example from your own work and walked through what you did.',
  partly: () => 'This came up, and your example stayed brief, so there was less to go on than the role asks for.',
  'not-covered': () => 'This did not come up in the time we had, so there is nothing here either way.',
};

const FURTHER_TEMPLATES: Readonly<Record<CoverageMarker, (name: string) => string>> = {
  strength: () => 'Name the result as well as the work: what changed because of it, and how you knew.',
  partly: () => 'Walk through the steps you took, the choices you weighed, and what changed as a result.',
  'not-covered': (name) => `Have one short story ready about ${name.toLowerCase()}: what you did, and what you took from it.`,
};

/** The competency rows: names, markers, quotes and what the role asks — never the model's. */
function competencyFacts(input: FeedbackInput): FeedbackCompetency[] {
  const defined = new Map((input.profile?.competencies ?? []).map((c) => [c.id, c]));
  const used = new Set<string>();
  const scores = Array.isArray(input.result.competencies) ? input.result.competencies : [];
  // Covered first: the letter should open on what the candidate did show.
  const order: Record<CoverageMarker, number> = { strength: 0, partly: 1, 'not-covered': 2 };
  return [...scores]
    .sort((a, b) => order[coverageMarker(a)] - order[coverageMarker(b)])
    .slice(0, MAX_COMPETENCIES)
    .map((c) => {
      const marker = coverageMarker(c);
      return {
        id: c.id,
        name: c.name,
        marker,
        roleAsks: roleAsksFor(c.name, defined.get(c.id)),
        whatWeHeard: HEARD_TEMPLATES[marker](c.name),
        quote: marker === 'not-covered' ? '' : firstQuote(c, used),
        toGoFurther: FURTHER_TEMPLATES[marker](c.name),
      };
    });
}

// ---------------------------------------------------------------------------
// The prose, without a model
// ---------------------------------------------------------------------------

/** True of anyone who sat through an interview, and nothing more. */
export const GENERIC_SWOT: FeedbackSwot = {
  strengths: [
    'You engaged openly with the questions and drew on examples from your own experience.',
    'You stayed with the conversation through to the end, and we appreciated the time you gave it.',
  ],
  weaknesses: [
    'Some examples ended before the outcome, so what changed as a result was left unsaid.',
    'There was not always time to hear the specific tools and choices behind the work.',
  ],
  opportunities: [
    'One concrete detail per story — what you changed, and what it saved — lifts every answer.',
    'Naming the part you personally played makes the scale of your work much clearer.',
  ],
  watchOuts: [
    'Long answers can drift, and the strongest point often arrives last. Lead with it.',
    'Saying "we" where the decision was yours can read as a smaller part than you had.',
  ],
};

export const GENERIC_NEXT_STEPS: readonly string[] = [
  'Take your three best examples and write the last line of each: what changed, in numbers where you have them.',
  'Re-tell one of those stories out loud, naming your own decisions, and keep "we" for what the team truly did together.',
  'Keep a two-sentence story ready for each tool on your CV: a limit you hit, and how you worked around it.',
];

function swotFromEvidence(competencies: readonly FeedbackCompetency[]): FeedbackSwot {
  const strong = competencies.filter((c) => c.marker === 'strength');
  const partly = competencies.filter((c) => c.marker === 'partly');
  const missing = competencies.filter((c) => c.marker === 'not-covered');

  const fill = (items: string[], fallback: readonly string[]) => {
    const out = items.slice(0, 3);
    for (const extra of fallback) {
      if (out.length >= 2) break;
      if (!out.includes(extra)) out.push(extra);
    }
    return out;
  };

  return {
    strengths: fill(strong.map((c) => `${c.name}: you gave a concrete example from your own work.`), GENERIC_SWOT.strengths),
    // Only ever about something the candidate actually spoke to, or about what
    // there was no time for — never a gap we are guessing at.
    weaknesses: fill([
      ...partly.map((c) => `${c.name}: the example stayed brief, so there was less to go on than the role asks for.`),
      ...missing.map((c) => `${c.name} did not come up, so there is nothing on it either way.`),
    ], GENERIC_SWOT.weaknesses),
    // The competency's own name, as the scorecard writes it: lower-casing it
    // turned "SQL" into "sql" in front of the candidate.
    opportunities: fill(strong.map((c) => `Lead with ${c.name} — it was the clearest thing you showed us.`), GENERIC_SWOT.opportunities),
    // Advice, not an assertion about this person.
    watchOuts: fill([], GENERIC_SWOT.watchOuts),
  };
}

function nextStepsFromEvidence(competencies: readonly FeedbackCompetency[]): string[] {
  const partly = competencies.find((c) => c.marker === 'partly');
  const missing = competencies.find((c) => c.marker === 'not-covered');
  const steps: string[] = [];
  if (partly) steps.push(`Write out one ${partly.name.toLowerCase()} story in full: the situation, what you did, and what changed. This week.`);
  if (missing) steps.push(`Prepare a short example about ${missing.name.toLowerCase()}, so it is ready the next time it comes up.`);
  for (const generic of GENERIC_NEXT_STEPS) {
    if (steps.length >= 3) break;
    if (!steps.includes(generic)) steps.push(generic);
  }
  return steps.slice(0, 3);
}

/** The whole letter, deterministic, with no model involved. */
export function buildEvidenceFeedback(input: FeedbackInput): FeedbackContent {
  const competencies = competencyFacts(input);
  const covered = competencies.filter((c) => c.marker !== 'not-covered');
  return {
    swot: covered.length ? swotFromEvidence(competencies) : GENERIC_SWOT,
    competencies,
    nextSteps: covered.length ? nextStepsFromEvidence(competencies) : [...GENERIC_NEXT_STEPS],
  };
}

// ---------------------------------------------------------------------------
// The model's part
// ---------------------------------------------------------------------------

export interface FeedbackPromptInput {
  readonly competencies: ReadonlyArray<{
    readonly id: string;
    readonly competency: string;
    readonly coverage: string;
    readonly roleAsks: string;
    readonly theirWords: string;
  }>;
}

/**
 * What the model is shown: names, coverage in words, what the role asks and
 * the candidate's quoted words. No level, score, weight or recommendation
 * reaches it, so it has none to repeat.
 */
export function feedbackPromptInput(input: FeedbackInput): FeedbackPromptInput {
  return {
    competencies: competencyFacts(input).map((c) => ({
      id: c.id,
      competency: c.name,
      coverage: MARKER_LABEL[c.marker],
      roleAsks: c.roleAsks,
      theirWords: c.quote,
    })),
  };
}

/** The model's prose over our facts. Notes for unknown competencies are dropped. */
export function composeFeedbackContent(opts: { facts: readonly FeedbackCompetency[]; model: ModelFeedback }): FeedbackContent {
  const notes = new Map(opts.model.notes.map((n) => [n.competencyId, n]));
  return {
    swot: opts.model.swot,
    competencies: opts.facts.map((c) => {
      const note = notes.get(c.id);
      return note ? { ...c, whatWeHeard: note.whatWeHeard, toGoFurther: note.toGoFurther } : c;
    }),
    nextSteps: opts.model.nextSteps,
  };
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

/**
 * Words that turn feedback into a verdict, a promise or a machine's report.
 *
 * Checked on every field we write. The candidate's quoted words and the
 * employer's own description of the role are checked too, but only for
 * exclusionary and protected-characteristic wording: "we passed the fix to
 * on-call" is not a pass mark, and a job description is about the job.
 */
const VERDICT_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly label: string }> = [
  { re: /\bscor(e|es|ed|ing)\b/i, label: 'score' },
  { re: /\d+(\.\d+)?\s*(\/|out of)\s*\d+/i, label: 'score' },
  { re: /\d+\s*%|\bper ?cent(ile)?\b/i, label: 'percentage' },
  { re: /\blevels?\b/i, label: 'level' },
  { re: /\brat(ed|ing|ings)\b/i, label: 'rating' },
  { re: /\brecommend\w*/i, label: 'recommendation' },
  // The candidate passing or failing, not "recovery after a failed load".
  { re: /\byou (have |did )?(passed|failed|did not pass)\b|\b(pass|passed|fail|failed) (the|this|our|your) (interview|assessment|test|section|round|stage|screen)\b|\bpass mark\b/i, label: 'pass/fail' },
  { re: /\brank\w*/i, label: 'ranking' },
  { re: /\b(other|fellow) (candidates|applicants)\b|\bcompared (with|to)\b/i, label: 'comparison' },
  // Our deciding, not theirs: "how you decide what to test first" is feedback.
  { re: /\bwe('ve| have| had)? decided\b|\b(we|the team) (will|would|are going to) decide\b|\b(hiring )?decision (on|about) (you|your)\b|\bhiring decision\b/i, label: 'decision' },
  { re: /\bhire[sd]?\b|\boffer\b|\breject\w*|\b(un)?successful\b|\bshortlist\w*/i, label: 'decision' },
  { re: /\bprogress(ed|ing)\b|\byour application\b|\bnext (round|stage|step)s?\b/i, label: 'decision' },
  // What happens to this person next. Worded around the candidate, so a story
  // about their own work — "we moved forward with Qualtrics" — is still theirs.
  { re: /\b(mov(e|es|ed|ing)|tak(e|es|ing)|put(ting)?|push(ing)?) (you|your application|things|this) (forward|through|on)\b/i, label: 'decision' },
  { re: /\b(advanc|progress|proceed|move)\w* (you|your application)\b|\bwe (will |would |are going to )?proceed\b/i, label: 'decision' },
  { re: /\byou (are|were|have been|will be|are being) (not )?(selected|chosen|shortlisted|progressed|advanced)\b/i, label: 'decision' },
  { re: /\b(a|an|not a|the) (good|strong|great|poor|bad|right|wrong|close)? ?fit\b/i, label: 'decision' },
  { re: /\bweight\w*|\bthreshold\b|\bthe bar\b/i, label: 'weighting' },
  { re: /\bguarantee\w*|\bpromise\w*|\bwill (hear|be in touch|contact)\b/i, label: 'promise' },
  { re: /\b(PROCEED|CONSIDER|DO_NOT_PROGRESS|SCORING_UNAVAILABLE)\b/, label: 'recommendation' },
  { re: /\bAI\b/, label: 'AI' },
  { re: /\bartificial intelligence\b|\bautomat(ed|ic|ically)\b|\balgorithm\w*|\bmachine learning\b|\blanguage model\b|\bchat ?bot\b/i, label: 'AI' },
];

/** Applies to everything, ours or theirs. */
function personChecks(text: string): string[] {
  const out: string[] = [];
  for (const issue of lintJd(text)) out.push(`exclusionary:${issue.term.toLowerCase()}`);
  out.push(...screenQuestion(text).violations, ...validateNoProtectedInference(text).violations);
  return out;
}

/** Numbers, levels, verdicts, promises and AI: the sweep for anything that reads as our judgement. */
function verdictChecks(text: string): string[] {
  return VERDICT_PATTERNS.filter((p) => p.re.test(text)).map((p) => `verdict:${p.label}`);
}

/**
 * Every reason one sentence may not go to a candidate. The same sweep the
 * letter gets, exposed so the email template can be held to it too.
 */
export function textGuardrailViolations(text: string): string[] {
  return [...new Set([...verdictChecks(text), ...personChecks(text)])];
}

/**
 * Every reason this content may not go to a candidate; empty when it may.
 * Every field is swept the same way, the candidate's quoted words and the
 * employer's role description included: those are sanitised when the letter
 * is built (firstQuote, roleAsksFor), and this is the check that they were.
 */
export function feedbackGuardrailViolations(content: FeedbackContent): string[] {
  const parsed = feedbackContentSchema.safeParse(content);
  const violations: string[] = parsed.success ? [] : ['shape'];
  const texts = [
    ...content.swot.strengths, ...content.swot.weaknesses, ...content.swot.opportunities, ...content.swot.watchOuts,
    ...content.nextSteps,
    ...content.competencies.flatMap((c) => [c.name, c.whatWeHeard, c.toGoFurther, c.quote, c.roleAsks]),
  ];
  for (const text of texts) {
    if (text) violations.push(...textGuardrailViolations(text));
  }
  return [...new Set(violations)];
}

/**
 * Pick what goes out: the model's wording if it passes, else the wording built
 * from the evidence, else the generic wording over the same facts. `rejected`
 * lists why the earlier choices were refused, for the log — never for the
 * candidate.
 */
export function chooseFeedbackContent(opts: {
  model: ModelFeedback | null;
  input: FeedbackInput;
}): { content: FeedbackContent; source: FeedbackContentSource; rejected: string[] } {
  const rejected: string[] = [];
  const evidence = buildEvidenceFeedback(opts.input);

  if (opts.model) {
    const composed = composeFeedbackContent({ facts: evidence.competencies, model: opts.model });
    const problems = feedbackGuardrailViolations(composed);
    if (!problems.length) return { content: composed, source: 'model', rejected };
    rejected.push(...problems.map((p) => `model:${p}`));
  }

  const problems = feedbackGuardrailViolations(evidence);
  if (!problems.length) return { content: evidence, source: 'evidence', rejected };
  rejected.push(...problems.map((p) => `evidence:${p}`));

  // Last resort: our own safe wording over the same facts, with anything the
  // checks objected to — a quote, a line from the job description — left out.
  const generic: FeedbackContent = {
    swot: GENERIC_SWOT,
    competencies: evidence.competencies.map((c) => ({
      ...c,
      roleAsks: plainRoleAsks(c.name),
      whatWeHeard: HEARD_TEMPLATES[c.marker](c.name),
      quote: '',
      toGoFurther: FURTHER_TEMPLATES[c.marker](c.name),
    })),
    nextSteps: [...GENERIC_NEXT_STEPS],
  };
  return { content: generic, source: 'generic', rejected };
}
