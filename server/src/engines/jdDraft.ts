
import { z } from 'zod';
import { bandById, type BandId } from './experienceBands.js';
import { EXCLUSIONARY_TERMS } from './roleIntelligence.js';
import { generateJson } from '../providers/llm/index.js';

export const PROMPT_VERSION = 'jd-draft-v2';

export interface JdDraftInput {
  readonly title: string;
  readonly domainName: string;
  readonly familyName?: string;
  readonly summary: string;
  readonly marketSignal: string;
  readonly band: BandId;
  readonly regionName: string;
}

export interface DraftResult {
  readonly title: string;
  readonly text: string;
  readonly generator: 'llm' | 'heuristic';
  readonly model: string;
  readonly promptVersion: string;
}

const llmDraftSchema = z.object({ title: z.string().trim().min(2).max(160), text: z.string().trim().min(400).max(6000) }).strict();

export function lintJd(text: string): Array<{ term: string; suggestion: string }> {
  return EXCLUSIONARY_TERMS.filter((entry) => entry.re.test(text)).map((entry) => ({
    term: text.match(entry.re)?.[0] ?? '',
    suggestion: entry.suggestion,
  }));
}

export function personaliseJd(text: string, opts: { readonly techStack?: readonly string[] }): string {
  const stack = (opts.techStack ?? []).map((s) => s.trim()).filter(Boolean);
  if (!stack.length) return text;
  return `${text.trim()}\n\nTech stack: ${stack.join(', ')}.`;
}

/**
 * A candidate-facing job description from catalog fields alone. Written for the
 * person reading the advert: no catalog vocabulary (band, family, market
 * signal) and no rubric language, which belong to the hiring team.
 */
export function draftJdHeuristic(input: JdDraftInput): string {
  const band = bandById(input.band);
  return [
    input.title,
    '',
    'About the role',
    `${roleOpening(input.title, input.summary, band.abstraction)} ${LEVEL_SENTENCE[band.abstraction]}`,
    '',
    'What you will do',
    ...RESPONSIBILITIES[band.abstraction].map((b) => `- ${b}`),
    '',
    'What you bring',
    ...whatYouBring(band.id).map((b) => `- ${b}`),
    '',
    'Nice to have',
    `- Experience in ${input.domainName} or a closely related field, or transferable experience from similar work.`,
    band.abstraction === 'craft'
      ? '- Curiosity, and a habit of sharing what you learn with your team.'
      : '- Experience mentoring others or improving how a team works.',
    '',
    'Location',
    `${input.regionName}.`,
    '',
    CLOSING_LINE,
  ].join('\n');
}

const CLOSING_LINE = 'We welcome applicants from every background and will make reasonable adjustments at any stage of the process; just let us know what would help.';

type Abstraction = 'craft' | 'system' | 'organisation';

const LEVEL_SENTENCE: Record<Abstraction, string> = {
  craft: 'You will do hands-on work with regular feedback and support from experienced colleagues.',
  system: 'You will be accountable for your area end to end and help the people around you do their best work.',
  organisation: 'You will set direction across teams and shape how the wider organisation works.',
};

const RESPONSIBILITIES: Record<Abstraction, readonly string[]> = {
  craft: [
    'Deliver well-scoped pieces of work to a high standard, with regular feedback.',
    'Break problems down, ask good questions and write down what you learn.',
    'Work closely with teammates and reviewers to ship reliable results.',
    'Investigate issues carefully and improve your work based on evidence.',
    "Contribute to the team's everyday practices, handovers and quality checks.",
  ],
  system: [
    'Own significant work in your area from discovery through delivery and operation.',
    'Make sound trade-offs between quality, speed, cost and risk, and explain them clearly.',
    'Lead improvements to reliability and quality, and learn from what goes wrong.',
    'Work across functions and influence decisions without relying on authority.',
    'Mentor colleagues through reviews, pairing and practical examples.',
    'Turn broad goals into measurable plans and follow them through.',
  ],
  organisation: [
    'Set direction for work across several teams or a portfolio.',
    'Decide which bets to make and which to defer, and explain the trade-offs.',
    'Build ways of working that improve decisions beyond your own team.',
    'Develop leaders and specialists through coaching and clear expectations.',
    'Represent risks and opportunities to senior stakeholders with evidence.',
    'Measure whether the strategy is working, and adapt when the facts change.',
  ],
};

// Catalog summaries are written as imperatives ("Own...", "Design..."); these are the common openings.
const STARTS_WITH_VERB = /^(Own|Build|Design|Deliver|Lead|Develop|Drive|Turn|Run|Manage|Operate|Create|Help|Support|Shape|Set|Plan|Coordinate|Improve|Protect|Ensure|Advise|Analyse|Analyze|Research|Deploy|Maintain|Engineer|Translate|Partner|Guide|Oversee|Keep|Make|Serve|Sell|Grow|Care|Teach|Govern|Secure|Test|Integrate|Model|Produce|Prepare)\b/;

/** The opening sentence: what the person will own, from the catalog summary when it starts with a verb. */
function roleOpening(title: string, summary: string, abstraction: Abstraction): string {
  const text = summary.trim().replace(/\s+/g, ' ').replace(/[.]+$/, '');
  const article = /^[aeiou]/i.test(title) ? 'an' : 'a';
  if (text && STARTS_WITH_VERB.test(text)) {
    return `As ${article} ${title}, you will ${text.charAt(0).toLowerCase()}${text.slice(1)}.`;
  }
  const fallback = abstraction === 'craft'
    ? 'deliver high-quality work and grow your skills quickly'
    : abstraction === 'system'
      ? 'own important outcomes and raise the standard of the work around you'
      : 'shape the direction of the work and the people who deliver it';
  return text ? `As ${article} ${title}, you will ${fallback}. ${text}.` : `As ${article} ${title}, you will ${fallback}.`;
}

function whatYouBring(bandId: BandId): string[] {
  const band = bandById(bandId);
  const experience: Record<BandId, string> = {
    emerging: 'Some hands-on experience relevant to the role, from work, study, projects or volunteering. There is no minimum number of years: potential and evidence matter more than time served.',
    developing: 'Hands-on experience delivering work in this area, with growing independence.',
    established: 'A track record of delivering work in this area independently.',
    senior: 'A track record of owning significant work end to end and improving how others work.',
    principal: 'A track record of setting direction across teams and seeing it through.',
    executive: 'A track record of leading an organisation or function through change.',
  };
  const years = band.yearsPrior.min === 0
    ? null
    : `Typically ${band.yearsPrior.min}+ years of relevant experience, or equivalent evidence of the scope described above.`;
  return [
    experience[bandId],
    ...(years ? [years] : []),
    'Clear written and spoken communication about decisions, trade-offs and risks.',
    'A collaborative way of working that makes the people around you better.',
  ];
}

export async function draftJdWithLlm(input: JdDraftInput): Promise<DraftResult | null> {
  const band = bandById(input.band);
  const raw = await generateJson<{ title: string; text: string }>({
    fn: 'jd_draft',
    system:
      'You write fair, plain-text job descriptions for a shared library that many employers start from. Return JSON {"title","text"}. ' +
      'Sections: title line, About the role, What you will do (5-7 bullets), What you bring, Nice to have, Location, and a closing line welcoming applicants from every background and offering reasonable adjustments. ' +
      'Write for the candidate, in plain words, and pitch the work at the given level. ' +
      'Do not name any company, salary, benefits or perks. Do not use catalog words like "band", "family" or "market signal". ' +
      'Express experience as evidenced scope, with years only as a guide ("typically N+ years or equivalent evidence"); at entry level ask for no minimum years. ' +
      'Never use age, gender, nationality, "native speaker", "digital native", "young", "recent graduate", or physical requirements.',
    user: JSON.stringify({
      title: input.title,
      field: input.domainName,
      whatTheRoleOwns: input.summary,
      level: band.label,
      levelFocus: band.abstraction,
      typicalYears: band.yearsPrior.min,
      location: input.regionName,
      promptVersion: PROMPT_VERSION,
    }),
    temperature: 0.2,
    maxTokens: 1800,
    validate: (value) => llmDraftSchema.parse(value),
  });
  if (!raw) return null;
  return { title: raw.title, text: raw.text, generator: 'llm', model: '', promptVersion: PROMPT_VERSION };
}

/**
 * A draft from the hiring team's own description. Tenant-specific, so it is
 * returned to the caller and never cached in the shared catalog.
 */
export async function draftJdFromDescriptionWithLlm(input: {
  readonly title?: string;
  readonly description: string;
  readonly band: BandId;
  readonly regionName: string;
  readonly domainName?: string;
}): Promise<DraftResult | null> {
  const band = bandById(input.band);
  const raw = await generateJson<{ title: string; text: string }>({
    fn: 'jd_draft_describe',
    system:
      'You turn a hiring team\'s short description into a fair, plain-text job description. Return JSON {"title","text"}. ' +
      'Sections: title line, About the role, What you will do, What you bring, Nice to have, Location, and a closing line welcoming applicants from every background and offering reasonable adjustments. ' +
      'Write for the candidate. Use only facts from the description; do not invent a company name, salary, benefits or perks. ' +
      'Express experience as evidenced scope, with years only as a guide ("typically N+ years or equivalent evidence"). ' +
      'Never use age, gender, nationality, "native speaker", "digital native", "young", "recent graduate", or physical requirements unless the description says they are essential.',
    user: JSON.stringify({ title: input.title ?? '', description: input.description, level: band.label, typicalYears: band.yearsPrior.min, location: input.regionName, field: input.domainName ?? '', promptVersion: PROMPT_VERSION }),
    temperature: 0.2,
    maxTokens: 1800,
    validate: (value) => llmDraftSchema.parse(value),
  });
  if (!raw) return null;
  return { title: raw.title, text: raw.text, generator: 'llm', model: '', promptVersion: PROMPT_VERSION };
}

export function draftJdFromDescriptionHeuristic(input: {
  readonly title?: string;
  readonly description: string;
  readonly band: BandId;
  readonly regionName: string;
  readonly domainName?: string;
}): string {
  const title = input.title?.trim() || 'Role';
  const band = bandById(input.band);
  const sentences = input.description.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const bullets = sentences.length >= 3
    ? sentences.slice(0, 6).map((s) => `${s.replace(/^you will\s+/i, '').replace(/^./, (c) => c.toUpperCase()).replace(/[.!?]+$/, '')}.`)
    : [...RESPONSIBILITIES[band.abstraction]];
  return [
    title,
    '',
    'About the role',
    `${input.description.trim()} ${LEVEL_SENTENCE[band.abstraction]}`,
    '',
    'What you will do',
    ...bullets.map((b) => `- ${b}`),
    '',
    'What you bring',
    ...whatYouBring(input.band).map((b) => `- ${b}`),
    '',
    'Nice to have',
    input.domainName
      ? `- Experience in ${input.domainName} or a closely related field, or transferable experience from similar work.`
      : '- Transferable experience from similar work.',
    '',
    'Location',
    `${input.regionName}.`,
    '',
    CLOSING_LINE,
  ].join('\n');
}
