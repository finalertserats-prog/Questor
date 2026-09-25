import type { Competency, RoleSuccessProfile } from '../domain/types.js';
import { EXCLUSIONARY_TERMS } from './roleIntelligence.js';

/**
 * How the interview opens: like a real first-round interview. A greeting by
 * name, what the role is mainly looking for, how long it runs, and the first
 * question — three short sentences, then the question.
 *
 * The AI disclosure (who the interviewer is, what is captured, that a person
 * reviews it) is NOT read out here. It is on the consent screen, before the
 * interview, where the candidate reads and agrees to it and where the consent
 * record stores exactly what they were shown. If the candidate asks during the
 * interview, the interviewer says truthfully that it is an AI (policyEngine
 * detectAiIdentityQuestion).
 *
 * Nothing here depends on which interviewer is speaking beyond the name, nor
 * on Tone: the content is the role's, the same for everyone.
 */

/** The first question, asked as part of the opening; lower-case because it always follows a lead-in. */
export const WARMUP_QUESTION =
  'could you briefly tell me about your current role and the project you\'ve worked on that\'s most relevant to this position?';

const MAX_FOCUS_AREAS = 3;

// Competencies that are the job itself, preferred over general behaviours
// when saying what the role is "mainly looking for".
const ROLE_SPECIFIC: ReadonlySet<Competency['category']> = new Set(['technical', 'domain', 'situational']);

const HONORIFIC = /^(dr|mr|mrs|ms|mx|miss|prof|professor)\.?$/i;

// "K", "K.", "A.B." — an initial, not a name anyone is greeted by.
const INITIAL = /^(?:\p{L}\.?)+$/u;

/** One letter per part, or dotted letters: "K", "J.", "A.B.". */
function isInitial(word: string): boolean {
  return INITIAL.test(word) && word.replace(/\./g, '').length <= 2 && (word.length === 1 || word.includes('.'));
}

/**
 * "JAYESH" → "Jayesh", "ANNE-MARIE" → "Anne-Marie". Only a word typed wholly in
 * capitals is recased: "McKenzie" or "DeShawn" is already how its owner writes it.
 */
function recaseShouted(word: string): string {
  if (word !== word.toUpperCase() || word === word.toLowerCase()) return word;
  return word.toLowerCase().replace(/(^|[-'])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * The name to greet someone by: the given name, without a title, and from
 * "SURNAME, Given" records as ATS exports often write them.
 *
 * Initials are skipped — a real greeting said "Hi K" to "K JAYESH RAHUL", where
 * K is a family initial in the South Indian convention — and a name typed in
 * capitals is said the way it is spelt, not shouted. When only initials are on
 * record the greeting goes without a name rather than by a letter.
 */
export function firstName(fullName: string | null | undefined): string {
  const raw = (fullName ?? '').trim();
  const comma = raw.indexOf(',');
  const given = comma > 0 ? raw.slice(comma + 1) : raw;
  const words = given.trim().split(/\s+/).filter((w) => w && !HONORIFIC.test(w));
  const named = words.find((w) => !isInitial(w));
  return named ? recaseShouted(named) : '';
}

/**
 * The role title as it is said aloud in "For this <title> role": without a
 * trailing "role" or "position" (no "role role"), and without the qualifiers
 * titles carry after "(" or " - " (a team, a city, a contract type). Falls
 * back to the raw title when cleaning would leave nothing.
 */
export function spokenRoleTitle(title: string | null | undefined): string {
  const raw = (title ?? '').trim();
  const cut = raw.split(/\s*\(|\s+-\s+/)[0] ?? '';
  const cleaned = cut.replace(/\s+(role|position)$/i, '').trim();
  return cleaned || raw;
}

/**
 * Up to three things the role is mainly looking for, from its approved
 * scorecard: scored competencies, heaviest first, role-specific ones ahead of
 * general behaviours. Names carrying exclusionary wording are dropped rather
 * than spoken — the same list the JD engine lints against.
 */
export function focusAreas(role: Pick<RoleSuccessProfile, 'competencies'>): string[] {
  const scored = role.competencies
    .filter((c) => c.classification === 'essential' || c.classification === 'preferred')
    .filter((c) => c.name.trim() && !EXCLUSIONARY_TERMS.some((t) => t.re.test(c.name)));
  const byWeight = (a: Competency, b: Competency) => b.weight - a.weight;
  const ordered = [
    ...scored.filter((c) => ROLE_SPECIFIC.has(c.category)).sort(byWeight),
    ...scored.filter((c) => !ROLE_SPECIFIC.has(c.category)).sort(byWeight),
  ];
  return ordered.slice(0, MAX_FOCUS_AREAS).map((c) => c.name.trim());
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export interface OpeningInput {
  readonly candidateName: string | null | undefined;
  readonly interviewerName: string | null | undefined;
  readonly roleTitle: string | null | undefined;
  readonly focus: readonly string[];
  readonly durationMinutes: number;
  /**
   * Said aloud only when the candidate's consent screen said HR may observe.
   * Live observation needs the notice in the transcript as server-side proof
   * (services/observerPolicy.ts mayObserveLive), and a real interviewer would
   * mention a colleague sitting in anyway.
   */
  readonly observerNotice?: string;
}

const QUESTION_LEAD = "Let's start — ";

/**
 * The question inside an opening, for when it has to be put again on a
 * rejoin: greeting a candidate a second time mid-interview reads as the
 * interviewer having forgotten them. Text that is not an opening is returned
 * as it is.
 */
export function openingQuestion(openingText: string): string {
  const at = openingText.lastIndexOf(QUESTION_LEAD);
  if (at < 0) return openingText;
  const question = openingText.slice(at + QUESTION_LEAD.length).trim();
  return question ? question.charAt(0).toUpperCase() + question.slice(1) : openingText;
}

export function buildOpeningGreeting(input: OpeningInput): string {
  const who = firstName(input.candidateName);
  const me = (input.interviewerName ?? '').trim();
  const hello = who && me ? `Hi ${who}, I'm ${me}`
    : who ? `Hi ${who}`
      : me ? `Hi, I'm ${me}`
        : 'Hi';
  const title = spokenRoleTitle(input.roleTitle);
  const forRole = title ? `For this ${title} role` : 'For this role';
  const looking = input.focus.length
    ? `${forRole}, we're mainly looking for strength in ${listOf(input.focus)}.`
    : `${forRole}, we'd like to hear how you've approached the work it involves.`;
  return [
    `${hello} — thanks for making the time today.`,
    looking,
    `We'll spend about ${input.durationMinutes} minutes together, and feel free to ask me to repeat anything.`,
    ...(input.observerNotice ? [input.observerNotice] : []),
    `${QUESTION_LEAD}${WARMUP_QUESTION}`,
  ].join(' ');
}
