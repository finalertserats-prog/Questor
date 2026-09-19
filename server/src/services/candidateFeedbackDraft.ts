import type { AssessmentResult, CompetencyScore } from '../domain/types.js';

/**
 * The candidate-facing feedback draft, built from the assessment's EVIDENCED
 * content and nothing else.
 *
 * This is the one place in the product where Questor's core claim has to hold
 * in candidate-readable prose: a competency the transcript does not support is
 * reported as "not covered in this interview", never as something the candidate
 * should work on. The rule is enforced structurally rather than by prompt — a
 * competency reaches the "worth working on" list only if it carries at least one
 * evidence span, so there is no path by which an unevidenced competency can be
 * described as a shortfall.
 *
 * Deliberately deterministic, with no model call:
 *
 *   - It must work in the zero-key build, which is the documented default
 *     (LLM_PROVIDER=heuristic, no API key) and the configuration the suite runs.
 *   - It runs on the request that ends a candidate's interview. A network call
 *     to a vendor there would put a paid dependency on the path where the
 *     candidate is still sitting in front of the page.
 *   - A generated paragraph is exactly the thing that would reintroduce an
 *     invented weakness, one plausible sentence at a time.
 *
 * The model's own `rationale` strings are NOT used. They are generated prose,
 * and while they are produced from evidence they are not themselves evidence.
 * What this draft asserts about a candidate is carried by two things a reader
 * can check: the competency name, and the candidate's own words.
 */

export const HEAD_STRENGTHS = 'What you did well';
export const HEAD_DEVELOP = 'Worth working on';
export const HEAD_OPPORTUNITY = 'Where you could go further';
export const HEAD_WATCH = 'Worth being aware of';
export const HEAD_NOT_COVERED = 'Not covered in this interview';

/** Longest quote we put in front of a candidate before trimming on a word boundary. */
const MAX_QUOTE_CHARS = 240;

/** Above this, a competency is already at the top of the scale — nothing to "go further" to. */
const TOP_LEVEL = 5;

export interface FeedbackDraft {
  readonly text: string;
  /** False when there was too little evidence to say anything fair. */
  readonly hasContent: boolean;
  readonly strengths: readonly string[];
  readonly develop: readonly string[];
  readonly notCovered: readonly string[];
}

/**
 * A competency is usable in candidate-facing prose only if it was actually
 * graded AND at least one span of what the candidate said backs it.
 *
 * `gradingUnavailable` is excluded even though such a row may carry a level:
 * that flag means the rubric call failed, which is a fact about our system and
 * not about the person.
 */
function isEvidenced(c: CompetencyScore): boolean {
  return !c.notEnoughEvidence
    && c.level !== null
    && !c.gradingUnavailable
    && Array.isArray(c.evidence)
    && c.evidence.length > 0;
}

function firstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0];
  return first || 'there';
}

function trimQuote(quote: string): string {
  const clean = quote.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_QUOTE_CHARS) return clean;
  const cut = clean.slice(0, MAX_QUOTE_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The candidate's own words, which is what makes every point checkable. */
function quoteBlock(c: CompetencyScore): string[] {
  const span = c.evidence[0];
  if (!span?.quote?.trim()) return [];
  return [`  You said: "${trimQuote(span.quote)}"`];
}

function section(heading: string, lead: string, items: string[]): string[] {
  if (!items.length) return [];
  return ['', `## ${heading}`, '', lead, '', ...items];
}

/**
 * Build the draft a human will edit before anyone sees it.
 *
 * No score, level, confidence figure or recommendation is carried across. Those
 * are the reviewer's decision-support, they are advisory-only by design, and a
 * candidate reading "level 2 of 5" would reasonably take it as a verdict that
 * no person had yet made.
 */
export function buildFeedbackDraft(opts: {
  candidateName: string;
  roleTitle: string;
  assessment: AssessmentResult;
}): FeedbackDraft {
  const competencies = Array.isArray(opts.assessment.competencies) ? opts.assessment.competencies : [];
  const evidenced = competencies.filter(isEvidenced);

  const strong = evidenced.filter((c) => (c.level ?? 0) >= c.requiredLevel);
  const shortfall = evidenced.filter((c) => (c.level ?? 0) < c.requiredLevel);
  const notCovered = competencies.filter((c) => !isEvidenced(c));

  const greeting = `Hello ${firstName(opts.candidateName)},`;
  const lines: string[] = [greeting, ''];

  if (!evidenced.length) {
    // Padding an empty interview into a SWOT is how feedback becomes flattery
    // or, worse, invention. Say what happened instead.
    lines.push(
      `Thank you for taking the time to talk to us about the ${opts.roleTitle} role, and for asking for written feedback.`,
      '',
      'Being straight with you: there was not enough of your interview for us to give you feedback that would '
      + 'actually be fair or useful. Rather than make something up, we would rather tell you that plainly.',
    );
    if (notCovered.length) {
      lines.push(
        '',
        `## ${HEAD_NOT_COVERED}`,
        '',
        'These did not come up, so there is nothing here about them either way:',
        '',
        ...notCovered.map((c) => `- ${c.name}`),
      );
    }
    lines.push(
      '',
      'If you would like to talk it through with someone on the team, say so using the link below.',
    );
    return {
      text: lines.join('\n'),
      hasContent: false,
      strengths: [],
      develop: [],
      notCovered: notCovered.map((c) => c.name),
    };
  }

  lines.push(
    `Thank you for taking the time to talk to us about the ${opts.roleTitle} role. You asked for written feedback, `
    + 'so here it is.',
    '',
    'Everything below comes from what you actually said in the interview — we have quoted you so you can see '
    + 'exactly what each point is based on. Someone on the hiring team has read this before it was sent.',
  );

  lines.push(...section(
    HEAD_STRENGTHS,
    'These came through clearly:',
    strong.flatMap((c) => [`- ${c.name}`, ...quoteBlock(c), '']),
  ));

  lines.push(...section(
    HEAD_DEVELOP,
    'These are the areas where what you showed us did not yet go as far as this role needs:',
    shortfall.flatMap((c) => [`- ${c.name}`, ...quoteBlock(c), '']),
  ));

  // Opportunity, kept honest: only ever said about something the candidate has
  // already evidenced, never about a gap we are guessing at.
  const opportunities = strong.filter((c) => (c.level ?? 0) < TOP_LEVEL);
  lines.push(...section(
    HEAD_OPPORTUNITY,
    'You are already solid on these, and they look like the places where you have the most room to build:',
    opportunities.map((c) => `- ${c.name}`),
  ));

  // The only thing allowed in the "watch" slot. Contradictions are derived from
  // the candidate's own statements conflicting with each other, so they are
  // evidenced by construction. Anything else here would be speculation about a
  // person's future, which is not ours to offer.
  const watch = (opts.assessment.contradictions ?? []).filter((s) => s.trim().length > 0);
  lines.push(...section(
    HEAD_WATCH,
    'Two things you told us did not quite line up. It may be nothing, but it is the kind of thing worth '
    + 'tightening before your next interview:',
    watch.map((s) => `- ${s}`),
  ));

  if (notCovered.length) {
    lines.push(...section(
      HEAD_NOT_COVERED,
      'We did not get to these, so nothing here counts for or against you on them:',
      notCovered.map((c) => `- ${c.name}`),
    ));
  }

  lines.push(
    '',
    'If any of this does not match how you remember the conversation, please tell us — we would genuinely '
    + 'rather know.',
  );

  return {
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    hasContent: true,
    strengths: strong.map((c) => c.name),
    develop: shortfall.map((c) => c.name),
    notCovered: notCovered.map((c) => c.name),
  };
}
