import { z } from 'zod';
import type { AssessmentResult, CompetencyScore } from '../domain/types.js';
import { lintJd } from '../engines/jdDraft.js';
import { screenQuestion, validateNoProtectedInference } from '../engines/policyEngine.js';

/**
 * What the candidate's automatic feedback email says, and the checks it must
 * pass before it may say it. Pure, so the rules are tested on their own
 * (tests/feedbackContentModel.test.ts); services/autoFeedbackContent.ts asks the
 * model and services/autoFeedback.ts sends.
 *
 * Nobody reads this email before the candidate does — that is the owner's
 * decision — so the guardrails carry the weight a reviewer used to. The rules:
 *
 *   - Built from the assessment's EVIDENCE: competency names and the
 *     candidate's own words. A competency that was not discussed is never
 *     described as something to work on (the same rule as
 *     candidateFeedbackDraft.ts).
 *   - No score, level, rating, recommendation, pass/fail, ranking, weighting,
 *     comparison with other candidates, or anything that reads as a hiring
 *     decision or a promise. The assessment's conclusions are advisory to the
 *     hiring team; the candidate must not receive one as a verdict nobody made.
 *   - Nothing about protected characteristics, and no exclusionary wording.
 *   - No mention of AI. The email is from the company's hiring team.
 *
 * Anything that fails falls back: model wording, then wording built from the
 * evidence, then safe generic wording that asserts nothing about the person.
 */

export interface FeedbackContent {
  readonly strengths: readonly string[];
  readonly develop: readonly string[];
  readonly suggestions: readonly string[];
}

export type FeedbackContentSource = 'model' | 'evidence' | 'generic';

const point = z.string().trim().min(20).max(400);

/** The shape every version of the content must have, whoever wrote it. */
export const feedbackContentSchema = z.object({
  strengths: z.array(point).min(2).max(3),
  develop: z.array(point).min(2).max(3),
  suggestions: z.array(point).min(1).max(2),
}).strict();

/**
 * True of anyone who sat through an interview, and nothing more. Used when
 * there is too little evidence to be specific, or when the specific wording
 * failed a check.
 */
export const GENERIC_FEEDBACK: FeedbackContent = {
  strengths: [
    'You engaged openly with the questions and drew on examples from your own experience.',
    'You stayed with the conversation through to the end, and we appreciated the time you gave it.',
  ],
  develop: [
    'Giving each example a clear shape — the situation, what you personally did, and what changed as a result — makes it easier to follow your thinking.',
    'Where you can, name the specific tools, choices and trade-offs involved, so the depth of your experience comes through.',
  ],
  suggestions: [
    'Before your next interview, pick two or three recent pieces of work and note down the problem, your own part in it and the outcome. It makes those stories much easier to tell when time is short.',
  ],
};

const MAX_POINTS = 3;
const MAX_SUGGESTIONS = 2;
/** Long enough to be recognisable, short enough to read as a quote rather than a transcript. */
const MAX_QUOTE_CHARS = 160;

/**
 * Usable only if it was actually graded and at least one span of what the
 * candidate said backs it. A failed grading call is a fact about our system,
 * not about the person.
 */
function isEvidenced(c: CompetencyScore): boolean {
  return !c.notEnoughEvidence && c.level !== null && !c.gradingUnavailable
    && Array.isArray(c.evidence) && c.evidence.some((e) => Boolean(e.quote?.trim()));
}

/** Bucketed by how far above or below the bar each one was — used for order only, never shown. */
function evidencedBuckets(result: AssessmentResult): { shown: CompetencyScore[]; toGrow: CompetencyScore[] } {
  const all = Array.isArray(result.competencies) ? result.competencies.filter(isEvidenced) : [];
  const margin = (c: CompetencyScore) => (c.level ?? 0) - c.requiredLevel;
  const shown = all.filter((c) => margin(c) >= 0).sort((a, b) => margin(b) - margin(a));
  const toGrow = all.filter((c) => margin(c) < 0).sort((a, b) => margin(a) - margin(b));
  return { shown, toGrow };
}

/** Straight double quotes inside would end our quotation early. */
function trimQuote(quote: string): string {
  const clean = quote.replace(/\s+/g, ' ').replace(/["“”]/g, "'").trim();
  if (clean.length <= MAX_QUOTE_CHARS) return clean;
  const cut = clean.slice(0, MAX_QUOTE_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The first quote for this competency not already used for another. One
 * answer often evidences several competencies, and the same sentence quoted
 * under three headings reads as though we heard only one thing.
 */
function unusedQuote(c: CompetencyScore, used: Set<string>): string {
  for (const span of c.evidence) {
    const quote = span.quote?.trim() ? trimQuote(span.quote) : '';
    if (quote && !used.has(quote)) {
      used.add(quote);
      return quote;
    }
  }
  return '';
}

const STRENGTH_TEMPLATES: ReadonlyArray<(name: string, quote: string) => string> = [
  (name, quote) => `${name} came across clearly. You gave a concrete example when you said "${quote}".`,
  (name, quote) => `You showed real substance on ${name}, for instance when you said "${quote}".`,
  (name, quote) => `Your answers on ${name} were specific and easy to follow: "${quote}" is a good example.`,
];

const UNQUOTED_STRENGTH_TEMPLATES: ReadonlyArray<(name: string) => string> = [
  (name) => `${name} came across clearly in the examples you gave.`,
  (name) => `You showed real substance on ${name}, with specific examples from your own work.`,
  (name) => `Your answers on ${name} were specific and easy to follow.`,
];

// The candidate's weaker answer is not quoted back at them: quoting it reads
// as an accusation. The competency name and a concrete way forward are enough.
const DEVELOP_TEMPLATES: ReadonlyArray<(name: string) => string> = [
  (name) => `On ${name}, there is room to go deeper. Walking through the specific steps you took, the choices you weighed and what changed as a result would show more of your experience.`,
  (name) => `${name} is worth building on. A concrete example with your own part in it and the outcome spelled out would make your experience here much clearer.`,
  (name) => `When ${name} came up, a more detailed example would help: the situation, what you personally did, and how you knew it had worked.`,
];

function fillTo(items: string[], fallback: readonly string[], min: number): string[] {
  const out = [...items];
  for (const extra of fallback) {
    if (out.length >= min) break;
    if (!out.includes(extra)) out.push(extra);
  }
  return out;
}

/**
 * Feedback worded from the evidence, with no model involved. Always has the
 * full shape; returns GENERIC_FEEDBACK itself when nothing was evidenced, so a
 * caller can tell the two apart.
 */
export function buildEvidenceFeedback(result: AssessmentResult): FeedbackContent {
  const { shown, toGrow } = evidencedBuckets(result);
  if (!shown.length && !toGrow.length) return GENERIC_FEEDBACK;

  const used = new Set<string>();
  const strengths = shown.slice(0, MAX_POINTS).map((c, i) => {
    const quote = unusedQuote(c, used);
    return quote
      ? STRENGTH_TEMPLATES[i % STRENGTH_TEMPLATES.length](c.name, quote)
      : UNQUOTED_STRENGTH_TEMPLATES[i % UNQUOTED_STRENGTH_TEMPLATES.length](c.name);
  });
  const develop = toGrow.slice(0, MAX_POINTS).map((c, i) => DEVELOP_TEMPLATES[i % DEVELOP_TEMPLATES.length](c.name));

  const suggestions: string[] = [];
  if (toGrow.length) {
    suggestions.push(`Before your next interview, prepare one or two short stories about ${toGrow[0].name}: the problem, what you personally did, and the outcome.`);
  }
  if (shown.length) {
    suggestions.push(`Keep using concrete examples like the ones you gave on ${shown[0].name}. They are the most convincing part of any answer.`);
  }

  return {
    strengths: fillTo(strengths, GENERIC_FEEDBACK.strengths, 2),
    develop: fillTo(develop, GENERIC_FEEDBACK.develop, 2),
    suggestions: fillTo(suggestions, GENERIC_FEEDBACK.suggestions, 1).slice(0, MAX_SUGGESTIONS),
  };
}

export interface FeedbackPromptInput {
  readonly clearlyShown: ReadonlyArray<{ competency: string; quotes: string[] }>;
  readonly roomToGrow: ReadonlyArray<{ competency: string; quotes: string[] }>;
}

/**
 * What the model is shown: buckets, names and quotes. No level, score, weight
 * or recommendation reaches it, so it has none to repeat.
 */
export function feedbackPromptInput(result: AssessmentResult): FeedbackPromptInput {
  const { shown, toGrow } = evidencedBuckets(result);
  const view = (c: CompetencyScore) => ({
    competency: c.name,
    quotes: c.evidence.map((e) => e.quote?.trim() ?? '').filter(Boolean).slice(0, 2).map(trimQuote),
  });
  return { clearlyShown: shown.slice(0, MAX_POINTS).map(view), roomToGrow: toGrow.slice(0, MAX_POINTS).map(view) };
}

/**
 * Words that turn feedback into a verdict, a promise or a machine's report.
 * Checked on our prose only — the candidate's quoted words are theirs, and
 * "we passed the fix to on-call" is not a pass mark.
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
  { re: /\bprogress(ed|ing)\b|\byour application\b|\bnext (round|stage)s?\b/i, label: 'decision' },
  { re: /\bweight\w*|\bthreshold\b|\bthe bar\b/i, label: 'weighting' },
  { re: /\bguarantee\w*|\bpromise\w*|\bwill (hear|be in touch|contact)\b/i, label: 'promise' },
  { re: /\b(PROCEED|CONSIDER|DO_NOT_PROGRESS|SCORING_UNAVAILABLE)\b/, label: 'recommendation' },
  { re: /\bAI\b/, label: 'AI' },
  { re: /\bartificial intelligence\b|\bautomat(ed|ic|ically)\b|\balgorithm\w*|\bmachine learning\b|\blanguage model\b|\bchat ?bot\b/i, label: 'AI' },
];

function withoutQuotes(text: string): string {
  return text.replace(/"[^"]*"/g, '""').replace(/“[^”]*”/g, '""');
}

/**
 * Every reason this content may not go to a candidate; empty when it may.
 * Exclusionary and protected-characteristic checks run over everything,
 * quotes included: a candidate mentioning their children should not see it
 * quoted back in an email about their interview.
 */
export function feedbackGuardrailViolations(content: FeedbackContent): string[] {
  const parsed = feedbackContentSchema.safeParse(content);
  const violations: string[] = parsed.success ? [] : ['shape'];
  const points = [...content.strengths, ...content.develop, ...content.suggestions];
  for (const text of points) {
    const prose = withoutQuotes(text);
    for (const p of VERDICT_PATTERNS) {
      if (p.re.test(prose)) violations.push(`verdict:${p.label}`);
    }
    for (const issue of lintJd(text)) violations.push(`exclusionary:${issue.term.toLowerCase()}`);
    violations.push(...screenQuestion(text).violations, ...validateNoProtectedInference(text).violations);
  }
  return [...new Set(violations)];
}

/**
 * Pick what goes out: the model's wording if it passes, else the evidence
 * wording if that passes, else the generic wording. `rejected` lists why the
 * earlier choices were refused, for the log — never for the candidate.
 */
export function chooseFeedbackContent(opts: {
  model: FeedbackContent | null;
  result: AssessmentResult;
}): { content: FeedbackContent; source: FeedbackContentSource; rejected: string[] } {
  const rejected: string[] = [];
  if (opts.model) {
    const problems = feedbackGuardrailViolations(opts.model);
    if (!problems.length) return { content: opts.model, source: 'model', rejected };
    rejected.push(...problems.map((p) => `model:${p}`));
  }
  const evidence = buildEvidenceFeedback(opts.result);
  if (evidence !== GENERIC_FEEDBACK) {
    const problems = feedbackGuardrailViolations(evidence);
    if (!problems.length) return { content: evidence, source: 'evidence', rejected };
    rejected.push(...problems.map((p) => `evidence:${p}`));
  }
  return { content: GENERIC_FEEDBACK, source: 'generic', rejected };
}
