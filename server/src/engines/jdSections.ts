import { COLLABORATION_VERB, isDropped, otherPartyClause, otherPartyObject, reclassifiedSection } from './jdExclusions.js';

/**
 * A job description, read as the structured document it actually is.
 *
 * Extraction used to match keywords against the whole advert at once, which
 * meant the perks list, the company's founding story and the equal-opportunity
 * paragraph all had the same standing as the requirements. They do not. A
 * competency may only come from where requirements actually live, and this is
 * the file that decides where that is.
 */

export type JdSectionKind =
  | 'company'
  | 'role_summary'
  | 'responsibilities'
  | 'requirements'
  | 'nice_to_have'
  | 'benefits'
  | 'boilerplate'
  | 'unknown';

export interface JdLine {
  /** 1-based, counted in the original text, so a span can be pointed at on screen. */
  readonly line: number;
  readonly text: string;
  readonly section: JdSectionKind;
}

export interface JdSection {
  readonly kind: JdSectionKind;
  /** The heading that opened it, or '' for the preamble. */
  readonly heading: string;
  readonly lines: readonly JdLine[];
}

/**
 * How much of a competency's case a section is allowed to make.
 *
 * Requirements outrank responsibilities because "you must have deep SQL" is a
 * statement about the candidate and "write complex SQL" is a statement about
 * the work — both are evidence, the first is stronger. The three zeros are the
 * point of the whole file: nothing a company says about itself, its perks or
 * its legal position can put a competency on a scorecard.
 */
const SECTION_WEIGHTS: Readonly<Record<JdSectionKind, number>> = {
  requirements: 1,
  responsibilities: 0.75,
  nice_to_have: 0.6,
  role_summary: 0.45,
  unknown: 0.4,
  company: 0,
  benefits: 0,
  boilerplate: 0,
};

/** Below this a section contributes nothing at all. */
export const MIN_CONTRIBUTING_WEIGHT = 0.4;

export function sectionWeight(kind: JdSectionKind): number {
  return SECTION_WEIGHTS[kind];
}

export function isContributing(kind: JdSectionKind): boolean {
  return SECTION_WEIGHTS[kind] >= MIN_CONTRIBUTING_WEIGHT;
}

/**
 * Headings, in the order they are tried. Nice-to-have is tested before
 * requirements so "Preferred qualifications" is not read as a requirement.
 */
const HEADINGS: ReadonlyArray<{ kind: JdSectionKind; re: RegExp }> = [
  { kind: 'nice_to_have', re: /^(nice[\s-]?to[\s-]?haves?|preferred|preferred (qualifications|skills|experience)|bonus( points)?|desirable|desired|good to have|would be a plus|pluses|also great|additionally)\b/i },
  { kind: 'requirements', re: /^(requirements?|required( skills| qualifications| experience)?|must[\s-]?haves?|minimum (qualifications|requirements|experience)|basic qualifications|qualifications|what (we|we're|we are) looking for|who you are|skills (and|&) experience|experience (required|we expect)|essential( skills| criteria)?|you (will )?(have|bring)|about you|your (background|experience))\b/i },
  { kind: 'responsibilities', re: /^(responsibilities|key responsibilities|what you('|’)?(ll| will) (do|be doing|own)|what you will be doing|the role involves|duties|day[\s-]to[\s-]day|in this role(,| you will)?|your impact|what the job involves|core duties|the work)\b/i },
  { kind: 'benefits', re: /^(benefits|perks|what we offer|we offer|compensation( and benefits)?|salary|rewards|why join|what('|’)?s in it for you)\b/i },
  { kind: 'boilerplate', re: /^(equal opportunit|diversity|eeo|legal|disclaimer|privacy|how to apply|application process|our commitment|note)\b/i },
  { kind: 'company', re: /^(about (us|the company|the team|acme)|who we are|our (company|story|mission|values|team)|the company|company overview)\b/i },
  { kind: 'role_summary', re: /^(about (the )?(role|job|position|opportunity)|the (role|opportunity|position)|(role|job|position) (summary|overview|purpose)|overview|summary|the opportunity)\b/i },
];

/** Headings are short, unpunctuated labels — usually with a colon, sometimes without. */
function headingKind(raw: string): JdSectionKind | null {
  const text = raw.trim().replace(/[:：]\s*$/, '').replace(/^[#*\-\s]+/, '').trim();
  if (!text || text.length > 80) return null;
  // A sentence is not a heading, however much it looks like one.
  if (/[.!?]$/.test(text) && !/[:：]\s*$/.test(raw.trim())) return null;
  const hasColon = /[:：]\s*$/.test(raw.trim());
  const match = HEADINGS.find((h) => h.re.test(text));
  if (!match) return null;
  // Without a colon, only accept a line that is nothing but the label, so a
  // requirement reading "Requirements are gathered from the field" is content.
  if (!hasColon && text.split(/\s+/).length > 7) return null;
  return match.kind;
}

/**
 * Split a job description into sections.
 *
 * Two passes. The first follows the document's own headings. The second
 * overrides them line by line, because adverts habitually trail an
 * equal-opportunity paragraph or a perks sentence off the end of whatever
 * section came last, with no heading to announce it.
 */
export function segmentJd(sourceText: string): JdSection[] {
  const raw = sourceText.replace(/\r/g, '').split('\n');
  const headingSeen = raw.some((l) => headingKind(l) !== null);

  let positional: JdSectionKind = headingSeen ? 'role_summary' : 'unknown';
  let heading = '';
  const placed: Array<{ line: JdLine; heading: string }> = [];

  for (let i = 0; i < raw.length; i += 1) {
    const text = raw[i].trim();
    if (!text) continue;
    const asHeading = headingKind(raw[i]);
    if (asHeading) {
      positional = asHeading;
      heading = text.replace(/[:：]\s*$/, '').trim();
      continue;
    }
    const body = text.replace(/^[\-\*•▪●o]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!body) continue;
    const section = reclassifiedSection(body) ?? positional;
    placed.push({ line: { line: i + 1, text: body, section }, heading });
  }

  const sections: JdSection[] = [];
  for (const { line, heading: h } of placed) {
    const last = sections[sections.length - 1];
    if (last && last.kind === line.section && last.heading === h) {
      (last.lines as JdLine[]).push(line);
      continue;
    }
    sections.push({ kind: line.section, heading: h, lines: [line] });
  }
  return sections;
}

/**
 * Every line a competency is allowed to be drawn from: in a section that
 * contributes, and not wholly about work another team owns.
 */
export function contributingLines(sourceText: string): JdLine[] {
  return segmentJd(sourceText)
    .filter((s) => isContributing(s.kind))
    .flatMap((s) => s.lines)
    .filter((l) => !isDropped(l.text));
}

/** Words that end the list of people you work with and start the work itself. */
const OBJECT_STOP = new Set([
  'to', 'so', 'while', 'whilst', 'in', 'across', 'ensuring', 'ensure', 'including',
  'by', 'through', 'as', 'when', 'where', 'that', 'who', 'which', 'on', 'for',
]);

/** A verb that means the sentence has turned back to this role's own work. */
const OWN_WORK_VERB = new Set([
  'own', 'owns', 'build', 'builds', 'design', 'designs', 'deliver', 'delivers', 'drive', 'drives',
  'lead', 'leads', 'manage', 'manages', 'create', 'creates', 'maintain', 'maintains', 'define',
  'defines', 'develop', 'develops', 'implement', 'implements', 'operate', 'operates', 'write',
  'writes', 'ensure', 'ensures', 'ship', 'ships', 'run', 'runs', 'scale', 'scales', 'optimise',
  'optimize', 'architect', 'analyse', 'analyze', 'report', 'present', 'monitor', 'automate',
  'test', 'deploy', 'document', 'mentor', 'review', 'translate', 'produce', 'deliver',
]);

const MAX_OBJECT_WORDS = 8;
const MASK = '…';

/**
 * Remove the people, and keep the work.
 *
 * "Partner with product teams to deliver trustworthy data" becomes
 * "Partner with … to deliver trustworthy data": the mention of Product is
 * gone, and "deliver trustworthy data" — which genuinely is this role's job —
 * survives to be read. Throwing the whole line away would lose real
 * requirements; keeping it whole is what produced a Product Management
 * competency on a data engineering role.
 */
export function maskCollaborationObjects(line: string): string {
  let masked = maskAfterCollaborationVerb(line);
  // Once another team becomes the subject, the rest of that clause is theirs.
  const clause = otherPartyClause(masked);
  if (clause) masked = `${masked.slice(0, clause.from)}${MASK}${masked.slice(clause.to)}`;
  // A plain "with the procurement team" names somebody else just as squarely
  // as "partner with" does, and adverts use it constantly.
  const other = otherPartyObject(masked);
  if (other) masked = masked.replace(other[1], MASK);
  // "Sit with our front-end engineers, who build in React, while they
  // implement your work." Masking the people left the relative clause behind,
  // and "build in React" made a designer a front-end engineer. The clause
  // describes what THEY do, so it goes with them.
  masked = masked.replace(/…\s*,?\s*who\b[^.;]*/i, MASK);
  return masked.replace(/\s+/g, ' ').trimEnd();
}

function maskAfterCollaborationVerb(line: string): string {
  const verb = COLLABORATION_VERB();
  const match = verb.exec(line);
  if (!match) return line;

  const after = line.slice(match.index + match[0].length);
  const words = after.split(/(\s+)/); // keeps the separators, so spacing survives
  let consumed = 0;
  let taken = 0;

  for (let i = 0; i < words.length; i += 1) {
    const token = words[i];
    if (/^\s+$/.test(token) || token === '') {
      consumed += token.length;
      continue;
    }
    const bare = token.replace(/[.,;:]+$/, '').toLowerCase();
    if (taken > 0 && OBJECT_STOP.has(bare)) break;
    // "…the business and own the data contracts" — "and own" turns the sentence
    // back to this role, so the object list ended at "the business".
    if (bare === 'and' && OWN_WORK_VERB.has(nextWord(words, i))) break;
    if (taken >= MAX_OBJECT_WORDS) break;
    consumed += token.length;
    taken += 1;
    if (/[.;:!?]$/.test(token)) break;
  }

  if (taken === 0) return line;
  const head = line.slice(0, match.index + match[0].length);
  const tail = after.slice(consumed);
  return `${head} ${MASK}${tail}`.replace(/\s+/g, ' ').trimEnd();
}

function nextWord(words: readonly string[], from: number): string {
  for (let i = from + 1; i < words.length; i += 1) {
    if (/^\s+$/.test(words[i]) || words[i] === '') continue;
    return words[i].replace(/[.,;:]+$/, '').toLowerCase();
  }
  return '';
}

/** The line as the extractor should read it: other people's disciplines removed. */
export function readableText(line: JdLine): string {
  return maskCollaborationObjects(line.text);
}
