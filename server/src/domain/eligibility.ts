/**
 * The requirements a conversation cannot settle.
 *
 * Almost everything an advert asks for is a capability: it is graded on a
 * ladder, probed in an interview, and weighed against everything else. A
 * licence is not. Either the person holds an active one or they do not, no
 * amount of interviewing moves the answer, and being wrong about it is a legal
 * problem rather than a hiring one.
 *
 * Until now those lines were reclassified out of competency extraction —
 * correctly, because they are not competencies — and then nothing picked them
 * up again. An advert that legally required a registration produced a scorecard
 * that never mentioned it.
 *
 * What this file decides is only which lines are of that shape. It decides
 * nothing about a candidate, and by design it cannot: an eligibility
 * requirement is surfaced to a person with whatever the CV does or does not
 * say beside it, and the person decides. There is no pass, no fail, no score
 * and no filter anywhere in this lane.
 */

import type { CvEvidence } from './cvFacts.js';

export const ELIGIBILITY_KINDS = [
  'right_to_work', 'clearance', 'registration', 'licence', 'certification', 'education',
] as const;

export type EligibilityKind = (typeof ELIGIBILITY_KINDS)[number];

export interface EligibilityRequirement {
  readonly id: string;
  readonly kind: EligibilityKind;
  /** The advert's own line, verbatim, minus its bullet. No span, no requirement. */
  readonly text: string;
  /** 1-based line number in the job description, so the claim can be checked. */
  readonly line: number;
}

/** One requirement with whatever the CV says about it — and no verdict on either. */
export interface EligibilityRead {
  readonly id: string;
  readonly kind: EligibilityKind;
  /** The advert's line, so the requirement is quoted rather than paraphrased. */
  readonly requirement: string;
  /** 1-based line of the job description it came from. */
  readonly line: number;
  /** CV lines that mention it. Empty is silence, and the note says so. */
  readonly evidence: readonly CvEvidence[];
  /** What a person should take from this, written so it can only be read one way. */
  readonly note: string;
}

/** How each kind is introduced when it is read out to a person. */
export const ELIGIBILITY_KIND_WORDS: Readonly<Record<EligibilityKind, string>> = {
  right_to_work: 'Right to work',
  clearance: 'Security clearance',
  registration: 'Professional registration',
  licence: 'Licence',
  certification: 'Certification',
  education: 'Education',
};

/**
 * The credential nouns, narrowest first, so a line is named by the most
 * specific thing in it.
 *
 * Every one of these is a word that ordinary adverts also use innocently, so
 * none of them is sufficient on its own — see `eligibilityKindOf` for what has
 * to be true as well. The narrowing inside each pattern is where most of the
 * precision lives:
 *
 *   "clearance" alone is a settlement term in banking operations, so only a
 *   clearance that is named as one counts;
 *
 *   "registration" alone is what users do on a website, so it has to be
 *   registration WITH somebody;
 *
 *   "degree" alone is the commonest false positive in the English language of
 *   job adverts — "a high degree of ambiguity" — so a degree has to be in
 *   something, or be named as an academic one.
 */
const CREDENTIAL_SOURCES: ReadonlyArray<{ readonly kind: EligibilityKind; readonly source: string }> = [
  {
    kind: 'right_to_work',
    source: String.raw`\b(?:right to work|work(?:ing)? (?:authorisation|authorization|permit|visa)|eligib(?:le|ility) to work|authoris(?:ed|ation) to work|authoriz(?:ed|ation) to work|settled status|permanent residen(?:t|cy))\b`,
  },
  {
    kind: 'clearance',
    source: String.raw`(?:\b(?:security|government|national|baseline personnel|developed vetting|counter[- ]terrorist|sc|dv|bpss)\s+clearance\b|\bsecurity[- ]cleared\b|\bclearance (?:is|at|to) )`,
  },
  {
    kind: 'registration',
    source: String.raw`\b(?:regist(?:ration|ered|rant)\s+(?:with|as|on)\s+(?:the\s+)?[\w&/-]+|professional registration)\b`,
  },
  {
    kind: 'licence',
    source: String.raw`\b(?:licen[cs]e[sd]?|licensure)\b`,
  },
  {
    kind: 'certification',
    source: String.raw`\b(?:certifications?|certificates?|certified|chartered [\w-]+|charter(?:ed)? status)\b`,
  },
  {
    kind: 'education',
    source: String.raw`\b(?:(?:bachelor|master|honours|undergraduate|postgraduate|university|academic)'?s?\s+degree|degrees?\s+(?:in|or\s+equivalent|level)|degree[- ]educated|doctorate|phd|diplomas?|qualifications?)\b`,
  },
];

const CREDENTIAL_PATTERNS = CREDENTIAL_SOURCES.map((c) => ({ kind: c.kind, re: new RegExp(c.source, 'i') }));

const ANY_CREDENTIAL = CREDENTIAL_SOURCES.map((c) => c.source).join('|');

/**
 * The advert stating a credential as something the person must already have,
 * rather than merely naming one.
 *
 * "Must", "required", "essential" and their neighbours. Deliberately not
 * "maintain" or "manage": an advert asking somebody to maintain an ISO
 * certification is describing the job, which is a competency, and an advert
 * asking whether they hold one is describing the person.
 */
const STATED_AS_REQUIRED = String.raw`\b(?:must\s+(?:be|hold|have|possess|carry|provide|show|already)|needs?\s+to\s+(?:be|hold|have|possess)|you\s+(?:must|will\s+need|should)|holders?\s+of|is\s+(?:essential|required|mandatory|a\s+requirement)|are\s+(?:essential|required|mandatory)|essential|required|mandatory|non[- ]negotiable|eligib(?:le|ility)|minimum\s+requirement)\b`;

/**
 * A credential named as one currently in force.
 *
 * "Full UK driving licence." carries no requirement word at all and is
 * unmistakably a requirement. The validity adjective does the same work the
 * word "required" would: nobody writes "active" about a credential they are
 * indifferent to.
 */
const IN_FORCE = String.raw`\b(?:full|valid|current|active|clean|unrestricted|in[- ]date|up[- ]to[- ]date|practi[cs]ing|registered|chartered)\s+(?:[\w&/-]+\s+){0,3}(?:licen[cs]e[sd]?|certificates?|certifications?|registration|clearance|membership|status)\b`;

/**
 * The line is about doing the work, not about holding the credential.
 *
 * "Experience with certification workflows in a regulated environment" names a
 * certification and is a competency: it is asking what the person has DONE.
 * Putting it in front of HR as a credential to check would be a requirement the
 * advert never made, which is its own kind of wrong — it spends the reviewer's
 * attention and then wastes it.
 */
const ABOUT_THE_WORK = String.raw`(?:\b(?:experience|exposure|familiar(?:ity)?|knowledge|understanding|track record|background)\s+(?:with|of|in|building|delivering|running|managing)\b|\b(?:builds?|designs?|manages?|managing|runs?|running|delivers?|maintains?|maintaining|leads?|leading|owns?|supports?|implements?|renews?)\b)`;

/**
 * The condition of an offer, which is the employer's own process rather than a
 * credential the candidate carries around.
 *
 * "All offers are subject to a right to work check" and "you must have the
 * right to work in the UK" say almost the same words and are not the same
 * thing. The first is something the employer will do later and no CV can speak
 * to; the second is a requirement of the person, which is the only kind of
 * thing this lane is for.
 */
const A_CONDITION_OF_THE_OFFER = String.raw`\b(?:subject to|conditional (?:up)?on|contingent (?:up)?on|pre-?employment|all (?:offers|appointments)|offers? (?:is|are|will be)|employment is)\b`;

/** Neither of the two things a credential line is most often mistaken for. */
const NOT_A_REQUIREMENT_OF_THE_PERSON = new RegExp(`${A_CONDITION_OF_THE_OFFER}|${ABOUT_THE_WORK}`, 'i');

/**
 * The exclusion rule's pattern, composed from the parts above so the rule and
 * the reader below can never fall out of step.
 *
 * A credential, stated as required or as currently in force, in a line that is
 * neither about the work nor about the conditions of an offer. Kept as a
 * function for the same reason `COLLABORATION_VERB` is: one source, two
 * callers, no second copy to drift.
 */
export function ELIGIBILITY_REQUIREMENT(): RegExp {
  return new RegExp(
    `^(?!.*(?:${A_CONDITION_OF_THE_OFFER}|${ABOUT_THE_WORK}))(?=.*(?:${ANY_CREDENTIAL}))`
    + `(?:(?=.*(?:${STATED_AS_REQUIRED}))|(?=.*(?:${IN_FORCE})))`,
    'i',
  );
}

/** The most specific credential named in a line, or null. */
export function credentialKindOf(line: string): EligibilityKind | null {
  return CREDENTIAL_PATTERNS.find((p) => p.re.test(line))?.kind ?? null;
}

/**
 * The kind of eligibility requirement this line states, or null.
 *
 * A credential, stated as held or required, and not swallowed by either of the
 * two things that look exactly like it: a description of the work, and a
 * condition the employer attaches to an offer.
 */
export function eligibilityKindOf(line: string): EligibilityKind | null {
  return ELIGIBILITY_REQUIREMENT().test(line) ? credentialKindOf(line) : null;
}

/** How long a bullet may be before it is prose about the job rather than a credential. */
const MAX_CREDENTIAL_WORDS = 16;

/**
 * A credential listed under Requirements with no requirement word attached.
 *
 * Adverts write "A degree in nursing, or an equivalent pre-registration award"
 * under a Requirements heading and consider the point made. It is: the heading
 * said "required" once and the list does not repeat it. This is only ever
 * applied to lines the advert itself filed under requirements — the same
 * sentence in a responsibilities list is about the work, and elsewhere in the
 * document it is usually about the company.
 */
export function listedCredentialKindOf(line: string): EligibilityKind | null {
  if (line.split(/\s+/).length > MAX_CREDENTIAL_WORDS) return null;
  if (NOT_A_REQUIREMENT_OF_THE_PERSON.test(line)) return null;
  return credentialKindOf(line);
}

/**
 * What to look for on a CV for each kind.
 *
 * Deliberately generous. These decide what gets QUOTED to a person, not what
 * gets concluded, so the cost of a loose match is a line the reviewer reads and
 * dismisses, and the cost of a tight one is a candidate's real credential going
 * unmentioned next to a requirement that says nothing was found.
 */
export const ELIGIBILITY_CV_TERMS: Readonly<Record<EligibilityKind, readonly RegExp[]>> = {
  right_to_work: [/right to work/i, /work permit/i, /\bvisa\b/i, /citizen(ship)?/i, /permanent residen/i, /settled status/i, /authoris(ed|ation)/i, /authoriz(ed|ation)/i],
  clearance: [/clearance/i, /\bcleared\b/i, /\bvetting\b/i, /\bsc\b|\bdv\b|\bbpss\b/],
  registration: [/regist(ered|ration|rant)/i, /\bmember(ship)? of\b/i],
  licence: [/licen[cs]e[sd]?/i, /licensure/i],
  certification: [/certif(icate|ication|ied)/i, /accredited/i, /chartered/i],
  education: [/degree/i, /bachelor|master|doctorate|diploma/i, /\bb\.?sc\b|\bb\.?a\b|\bm\.?sc\b|\bm\.?a\b|\bmba\b|\bphd\b/i, /graduat(e|ed|ion)/i],
};

/**
 * Words too common to be evidence of anything.
 *
 * The requirement's own distinctive words are searched for on the CV — "nursing"
 * out of "a degree in nursing" is what finds "BSc Nursing" — and these are the
 * ones that would match every CV ever written instead.
 */
const NOT_DISTINCTIVE = new Set([
  'must', 'have', 'hold', 'holds', 'holding', 'your', 'with', 'from', 'this', 'that', 'their',
  'will', 'need', 'needs', 'should', 'able', 'required', 'require', 'requires', 'essential',
  'mandatory', 'applicant', 'applicants', 'candidate', 'candidates', 'equivalent', 'relevant',
  'either', 'other', 'current', 'valid', 'active', 'full', 'clean', 'role', 'position', 'work',
  'working', 'before', 'within', 'practise', 'practice', 'award', 'eligible', 'eligibility',
  'start', 'first', 'site', 'related', 'subject', 'closely', 'genuine', 'willingness',
]);

/** The words in a requirement worth hunting for on a CV. */
export function distinctiveWords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !NOT_DISTINCTIVE.has(w)))];
}
