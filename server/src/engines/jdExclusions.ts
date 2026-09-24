import type { JdSectionKind } from './jdSections.js';

/**
 * What a job description says that is NOT a competency for this role.
 *
 * The failure this exists to stop: a Senior Data Engineer advert says "partner
 * with product teams", the extractor reads the word "product", and Product
 * Management becomes something every candidate for that role is measured and
 * scored against — feeding the interview's questions, the evidence quotes, the
 * assessment and the calibration loop. A collaboration mention names *other
 * people's* discipline. It is not a requirement of this job.
 *
 * Three different things can be wrong with a line, so there are three effects:
 *
 *   reclassify — the line belongs to a section that contributes nothing
 *                (benefits, company blurb, legal boilerplate), wherever it
 *                happens to sit in the document. Adverts routinely trail an
 *                equal-opportunity paragraph off the end of "Benefits:" with
 *                no heading of its own.
 *   drop       — the line is about work someone else owns. "The platform team
 *                owns the Kubernetes cluster" must not make Kubernetes a
 *                competency of this role.
 *   mask       — only *part* of the line is someone else's. "Work closely with
 *                the ML team to build feature pipelines" contains a genuine
 *                requirement (building feature pipelines) and a mention of
 *                another discipline (ML). Masking keeps the first and removes
 *                the second, which is why collaboration lines are not simply
 *                thrown away.
 */

export type ExclusionEffect = 'reclassify' | 'drop' | 'mask';

export interface ExclusionRule {
  readonly id: string;
  readonly re: RegExp;
  /** Said to a person when a competency was withheld, so the rule is arguable rather than mysterious. */
  readonly why: string;
  readonly effect: ExclusionEffect;
  /** Where a reclassified line actually belongs. */
  readonly section?: JdSectionKind;
}

/**
 * Order is load-bearing. The reclassifying and dropping rules are tried before
 * the masking ones, so a benefits line that happens to say "work with" is read
 * as a benefit rather than as a collaboration mention.
 */
export const EXCLUSION_RULES: readonly ExclusionRule[] = [
  {
    id: 'benefits',
    re: /\b(health (insurance|cover|care)|dental|vision cover|401\s*\(?k\)?|pension|paid time off|\bpto\b|vacation days|annual leave|parental leave|maternity|paternity|flexible (working|hours)|remote stipend|stock options?|\bequity\b|bonus (scheme|plan)|share options|gym|wellness|learning budget|training budget|competitive salary|compensation range|salary range|relocation (support|assistance)|free lunch|perks)\b/i,
    why: 'Names a benefit the employer offers, not a capability the job needs.',
    effect: 'reclassify',
    section: 'benefits',
  },
  {
    id: 'dei_statement',
    // No trailing \b: several alternatives here are deliberately prefixes
    // ("equal opportunit" covers opportunity and opportunities), and a word
    // boundary after a prefix never matches.
    re: /\b(equal opportunit|equal employment|diversity|diverse|inclusi(on|ve)|underrepresented|regardless of (race|gender|age|religion)|affirmative action|we welcome applicants|we encourage applications|do(es)? not discriminate|protected (class|characteristic|veteran))/i,
    why: 'Part of the employer\'s equal-opportunity statement, not a requirement of the role.',
    effect: 'reclassify',
    section: 'boilerplate',
  },
  {
    id: 'legal_notice',
    re: /\b(e-?verify|right to work|work authorisation|work authorization|background check|drug (screen|test)|at-will|visa sponsorship|sponsorship is not|privacy (policy|notice)|\bgdpr\b|terms and conditions|subject to (a |an )?(background|reference))\b/i,
    why: 'A legal or eligibility notice, not a competency.',
    effect: 'reclassify',
    section: 'boilerplate',
  },
  {
    id: 'company_narrative',
    // What the company does is not what the role requires.
    //
    // A front-end engineer at an accounting software company does not need
    // accounting; a principal engineer whose employer's software "sits
    // underneath a fifth of the UK's freight bookings" is not being hired for
    // supply chain. Every one of those was reaching a scorecard.
    //
    // "We need", "we expect", "we are looking for" are deliberately excluded:
    // those introduce requirements rather than describe the company.
    re: /^(we\s+(?!need|want|expect|require|are\s+looking|are\s+hiring|would|will\s+expect|offer)(?:are|were|make|build|sell|ship|power|serve|help|process|publish|run|operate|use)\b|our\s+(?:software|product|platform|infrastructure|technology|customers?|clients?|mission|business|revenue|founders?)\b)/i,
    why: 'Describes what the company does, not what the job needs.',
    effect: 'reclassify',
    section: 'company',
  },
  {
    id: 'company_commitment',
    re: /\b(we (have committed|are committed|were founded|are proud|believe|publish an?)|our (mission|vision|values) is)\b/i,
    why: 'Part of the company\'s description of itself, not a requirement of the role.',
    effect: 'reclassify',
    section: 'company',
  },
  {
    id: 'customer_function',
    // "Finance or accounting buyers." — naming who you sell to is not naming
    // what you must be able to do.
    re: /\b(buyers?|customers?|clients?|prospects?|audiences?)\b\s*[.;]?\s*$/i,
    why: 'Names the people the role sells to or serves, not a capability the role needs.',
    effect: 'drop',
  },
  {
    id: 'company_blurb',
    re: /\b(founded in|was founded|our mission|our vision|our values|our story|headquarter|we are a |we're a |series [a-e]\b|venture[- ]backed|profitable since|customers (in|across) \d|offices in|join us\b|we believe|about us\b|trusted by \d)/i,
    why: 'Describes the company, not the job.',
    effect: 'reclassify',
    section: 'company',
  },
  {
    id: 'application_process',
    re: /\b(apply (now|today|via|through|online)|how to apply|application (process|deadline)|interview process|our recruiter|talent (partner|acquisition) will|submit your (cv|resume|application)|cover letter|send your (cv|resume))\b/i,
    why: 'Describes how to apply, not what the job needs.',
    effect: 'reclassify',
    section: 'boilerplate',
  },
  {
    id: 'negated_requirement',
    // "You will not line manage anyone", "You are not the product owner",
    // "you do not need to code". Adverts say this deliberately, to stop the
    // wrong people applying — and the extractor was reading the denial as the
    // requirement, which is the most embarrassing way to be wrong.
    re: /\b(you (will|do|are|would|need)\s+not\b|you (won't|don't|aren't)\b|(this|it) is not a [\w&/-]+ (role|position|job)|no (prior |previous )?[\w&/-]+ (experience|background) (is )?(required|needed|necessary)|not responsible for|nor will you|you are not expected to|without (having to|needing to))/i,
    why: 'The advert says this is NOT part of the role.',
    effect: 'drop',
  },
  {
    id: 'other_team_tool',
    // Somebody else is the subject of the sentence.
    //
    // The narrow version of this rule only caught "the X team owns Y", and
    // adverts say it a dozen other ways: "Our CMO owns demand generation",
    // "Our legal counsel drafts the customer contracts", "Our data manager
    // produces the attainment dashboards you will use". Every one of those
    // was putting somebody else's discipline on this role's scorecard.
    //
    // "you will use" at the end does not rescue it: being handed a dashboard
    // is not the same as being hired to build one.
    re: /^(our|the)\s+(?:[\w&/-]+\s+){0,3}(?:teams?|groups?|functions?|practices?|departments?|squads?|chapters?|counsel|leads?|managers?|directors?|officers?|partners?|desks?|offices?|engineers?|designers?|analysts?|scientists?|specialists?|cmo|cto|cfo|ceo|coo)\b[^.]{0,40}?\b(?:owns?|runs?|builds?|produces?|manages?|handles?|places?|drafts?|advises?|raises?|maintains?|operates?|delivers?|writes?|sets?|leads?|does|do|will (?:own|run|build|produce|manage|handle|draft|advise|maintain|operate))\b/i,
    why: 'Describes what another team or person does, so it is not a capability this role is hired for.',
    effect: 'drop',
  },
  {
    id: 'other_team_owns',
    re: /\b((owned|maintained|managed|run|handled|drafted|produced) by (the |our )?[\w&/-]+( [\w&/-]+)? (team|group|function|lead|manager|counsel)|is handled by|sits with the)\b/i,
    why: 'Names a system another team owns, so it is not a capability this role is hired for.',
    effect: 'drop',
  },
  {
    id: 'collaboration_mention',
    re: COLLABORATION_VERB(),
    why: 'Names who the role works with. Their discipline is theirs, not a competency this role is measured on.',
    effect: 'mask',
  },
  {
    id: 'stakeholder_mention',
    re: /\b(stakeholders?|cross[- ]functional (partners|teams|stakeholders)|business partners|internal customers|counterparts)\b/i,
    why: 'A stakeholder mention names other people, not a capability this role is measured on.',
    effect: 'mask',
  },
];

/**
 * The verbs that introduce somebody else. Kept as a function so the same source
 * serves both the exclusion rule above and the masker below without two copies
 * of the pattern drifting apart.
 */
function COLLABORATION_VERB(): RegExp {
  return /\b(?:partner(?:ing|s|ed)?\s+with|work(?:ing|s|ed)?\s+(?:closely\s+|directly\s+|hand[- ]in[- ]hand\s+)?(?:with|alongside)|collaborat(?:e|es|ing|ed|ion)\s+with|liais(?:e|es|ing|ed)\s+with|coordinat(?:e|es|ing|ed)\s+with|engag(?:e|es|ing|ed)\s+with|interfac(?:e|es|ing|ed)\s+with|align(?:ing|s|ed)?\s+with|in\s+(?:close\s+)?partnership\s+with|in\s+collaboration\s+with|alongside\s+(?:the|our)|support(?:ing|s|ed)?\s+(?=(?:the\s+|our\s+)?(?:procurement|finance|legal|hr|sales|marketing|operations|engineering|product|compliance|[\w&/-]+\s+team))|paired?\s+with|sit\s+with)\b/i;
}

/**
 * Somebody else's clause, inside a sentence that is otherwise about this role.
 *
 * "Set the guardrails the platform team builds our cloud infrastructure
 * inside" is a security requirement that happens to mention a platform team
 * and cloud infrastructure. Read whole, it put Cloud & Platform Architecture
 * on a head of security's scorecard. Once the other party becomes the subject,
 * everything to the end of that clause is theirs.
 */
const OTHER_PARTY_CLAUSE =
  /\b(?:the|our)\s+(?:[\w&/-]+\s+){0,3}(?:teams?|groups?|functions?|practices?|leads?|managers?|counsel)\s+(?:who\s+)?(?:owns?|runs?|builds?|manages?|handles?|maintains?|operates?|produces?|places?|drafts?|advises?|does|do)\b/i;

/** The span of a clause that belongs to somebody else, or null. */
export function otherPartyClause(line: string): { readonly from: number; readonly to: number } | null {
  const match = OTHER_PARTY_CLAUSE.exec(line);
  if (!match) return null;
  const rest = line.slice(match.index);
  const end = rest.search(/[.;]/);
  return { from: match.index, to: end === -1 ? line.length : match.index + end };
}

/**
 * Any "with <somebody else>", not only after a collaboration verb.
 *
 * "Negotiate commercial terms with procurement teams who do this for a living"
 * is a negotiation requirement that mentions procurement. Reading it whole put
 * Procurement & Vendor Management on an account executive's scorecard. The
 * object is masked and the negotiation survives.
 */
const OTHER_PARTY = /\bwith\s+(?:the\s+|our\s+|their\s+)?((?:[\w&/-]+\s+){0,3}(?:teams?|groups?|functions?|practices?|departments?|squads?|engineers?|designers?|analysts?|scientists?|specialists?|managers?|leads?|counsel|colleagues|counterparts|partners|stakeholders?))\b/i;

export function otherPartyObject(line: string): RegExpExecArray | null {
  return OTHER_PARTY.exec(line);
}

/** The first rule a line trips, or null when nothing is wrong with it. */
export function excludedBy(line: string): ExclusionRule | null {
  for (const rule of EXCLUSION_RULES) {
    if (rule.re.test(line)) return rule;
  }
  return null;
}

/** The section a line belongs to regardless of where it was printed, if a rule moves it. */
export function reclassifiedSection(line: string): JdSectionKind | null {
  const rule = excludedBy(line);
  return rule?.effect === 'reclassify' ? rule.section ?? null : null;
}

/** True when the whole line is somebody else's work and must contribute nothing. */
export function isDropped(line: string): boolean {
  return excludedBy(line)?.effect === 'drop';
}

export { COLLABORATION_VERB };
