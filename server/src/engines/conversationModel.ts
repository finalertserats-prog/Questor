import type { TurnRecord } from '../domain/types.js';
import { bareYesNo, detectCandidateIntent, isSubstantiveAnswer } from './candidateIntent.js';
import { WARMUP_QUESTION, openingQuestion } from './openingModel.js';

/**
 * The conversational layer around the questions: what is still waiting to be
 * answered, how to say it again more simply, how to show the answer was heard,
 * and when a question would repeat one already asked. Pure — no model, no
 * database — so every rule here is pinned by a test.
 *
 * Built after a production transcript in which "Oh", "No", "Pause" and
 * "Nothing" were each followed up as if they were answers, "build versus buy"
 * was asked about five times, and "you mentioned…" introduced things the
 * candidate had never said.
 */

/** What the interviewer says when asked for a moment. It asks nothing new. */
export const PAUSE_REPLY = "Of course — take your time. Just say 'ready' when you'd like to carry on.";

/** What the interviewer says when the candidate asks to do this another time. */
export const POSTPONE_REPLY =
  "Of course — we can do this another time. I've let the hiring team know, and they'll send you a new time. Nothing from today will count against you. Thanks, and speak soon.";

/** Said before moving past a question the candidate could not or would not answer. */
export const MOVE_ON_LEAD = "No problem — let's move on.";

/**
 * Agent turns that manage the conversation rather than ask something new. The
 * question they relate to stays the one waiting for an answer.
 */
const MANAGEMENT_KINDS: ReadonlySet<string> = new Set(['pause', 'reask', 'rephrase', 'candidate_answer']);

/** Older transcripts carry no kind; these openings identify the same turns. */
const MANAGEMENT_PREFIXES = [PAUSE_REPLY.slice(0, 30), 'No problem — let me put it', 'Thanks for clarifying', 'Sure — here it is again'];

function isManagementTurn(t: TurnRecord): boolean {
  if (t.kind) return MANAGEMENT_KINDS.has(t.kind);
  return MANAGEMENT_PREFIXES.some((p) => t.text.startsWith(p));
}

export interface PendingQuestion {
  text: string;
  competencyId: string;
  /** Position in the transcript array given. */
  at: number;
}

/**
 * Sentences the interviewer says before a question rather than as part of it:
 * a move-on, an acknowledgement, a transition. Stripped when a question is put
 * again from a turn that did not store its bare question.
 */
const LEAD_IN = /^(?:No problem — let's move on\.|Thanks for clarifying — I had that wrong\.|Thanks for the correction — [^.?!]*\.|Thanks — that's useful context on [^.?!]*\.|Okay, that helps me picture [^.?!]*\.|Thanks for the detail on [^.?!]*\.|Got it — [^.?!]*, understood\.|Thanks for walking me through that\.|Okay, that makes sense\.|Understood, thank you\.|Got it, thanks\.|Let's turn to something different\.|I'd like to move to another area now\.|Let's shift gears\.|Thanks, that's helpful\.|Got it, appreciate the detail\.|Moving on\.|That makes sense\.|I'd like to explore something else now\.)\s+/;

function withoutLeadIn(text: string): string {
  let out = text;
  for (let next = out.replace(LEAD_IN, ''); next !== out && next.trim(); next = out.replace(LEAD_IN, '')) out = next;
  return out;
}

/** The question inside an opening; an older opening without the usual lead still asked the warm-up. */
function questionInOpening(text: string): string {
  const question = openingQuestion(text);
  return question === text ? `${WARMUP_QUESTION.charAt(0).toUpperCase()}${WARMUP_QUESTION.slice(1)}` : question;
}

/**
 * The question the candidate still owes an answer to: the latest agent turn
 * that asked something, skipping pauses and re-asks of it. The opening's
 * question comes back without its greeting.
 */
export function pendingQuestion(turns: readonly TurnRecord[]): PendingQuestion | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.speaker !== 'agent' || isManagementTurn(t)) continue;
    const opening = t.kind === 'opening' || t.competencyId === '__process__';
    const text = t.question ?? (opening ? questionInOpening(t.text) : withoutLeadIn(t.text));
    return { text, competencyId: t.competencyId ?? '', at: i };
  }
  return null;
}

/**
 * How many answers to the pending question in a row carried nothing. Pauses,
 * repeats and questions neither count nor reset it; a real answer resets it.
 */
export function nonAnswerStreak(turns: readonly TurnRecord[]): number {
  const pending = pendingQuestion(turns);
  if (!pending) return 0;
  let streak = 0;
  for (let i = pending.at + 1; i < turns.length; i++) {
    const t = turns[i];
    if (t.speaker !== 'candidate') continue;
    if (isAnswerInContext(turns, i)) { streak = 0; continue; }
    const { intent } = detectCandidateIntent(t.text);
    if (intent === 'non_answer' || intent === 'skip') streak += 1;
  }
  return streak;
}

// A question answerable with yes or no: an auxiliary opens it and NOTHING
// anywhere in the utterance asks for an account. Reading only the final
// question mark made "Were you the owner? Tell me what happened." a yes/no
// question, and "Is there an example you can share?" is an invitation to tell
// a story however it opens — a bare "Yes" answers neither, and scoring one as
// the answer puts an empty turn in front of a reviewer as evidence.
const AUXILIARY_OPENING = /^(?:so|and|but|just|ok|okay|right|now|then)?\s*(?:did|do|does|have|has|had|can|could|were|was|is|are|am|will|would|should|shall|may|might)\b/;
const ASKS_FOR_AN_ACCOUNT = /\b(?:what|how|why|which|who|whom|where|when|example|examples|instance|story|tell me|walk me|talk me|take me through|describe|explain|elaborate|share|give me|in detail|step by step)\b/;

/** The sentences of an utterance, in order. */
function sentences(text: string): string[] {
  return (text ?? '').split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** The last thing actually asked: the final question, or the final sentence. */
function finalQuestion(text: string): string {
  const parts = sentences(text);
  return [...parts].reverse().find((s) => s.endsWith('?')) ?? parts[parts.length - 1] ?? '';
}

/** Could this be answered with a bare yes or no, and nothing else? */
export function isYesNoQuestion(question: string): boolean {
  const whole = (question ?? '').toLowerCase();
  if (!whole.trim()) return false;
  // Judged over the whole utterance: one clause asking for an account is
  // enough, wherever it sits.
  if (ASKS_FOR_AN_ACCOUNT.test(whole)) return false;
  return AUXILIARY_OPENING.test(finalQuestion(question).toLowerCase());
}

/**
 * Is the candidate turn at `index` an answer, given what was asked?
 *
 * Context-free the answer is usually enough — "Oh", "Pause" and "Welcome back"
 * are nothing whatever the question. The exception is a bare "yes" or "no",
 * which is the whole answer to a yes/no question and nothing at all to an open
 * one.
 */
export function isAnswerInContext(turns: readonly TurnRecord[], index: number): boolean {
  const t = turns[index];
  if (!t || t.speaker !== 'candidate' || !t.text.trim()) return false;
  if (isSubstantiveAnswer(t.text)) return true;
  if (!bareYesNo(t.text)) return false;
  const asked = pendingQuestion(turns.slice(0, index));
  return !!asked && asked.competencyId !== '__candidate_questions__' && isYesNoQuestion(asked.text);
}

/** The ids of the candidate turns that are answers — what may be quoted as evidence. */
export function answeredTurnIds(turns: readonly TurnRecord[]): Set<string> {
  const ids = new Set<string>();
  turns.forEach((t, i) => { if (isAnswerInContext(turns, i)) ids.add(t.id); });
  return ids;
}

// One follow-up that turns a bare yes or no into evidence, without making the
// candidate feel caught out. Two wordings each, so a second one in the same
// interview is not the same sentence.
const AFTER_YES = [
  'Thanks — tell me how that went in practice: what did you actually do, and what came of it?',
  'Good — walk me through how you did it, and what the result was.',
];
const AFTER_NO = [
  'Understood — who handled that part, and what was your own involvement around it?',
  'That\'s useful to know — who did it instead, and what was your part alongside them?',
];

/** The follow-up that gets the story behind a bare yes or no. */
export function yesNoFollowup(answer: 'yes' | 'no', seed: number): string {
  return pick(answer === 'yes' ? AFTER_YES : AFTER_NO, seed);
}

/**
 * The turns of the current sitting. A postponed interview that is re-invited
 * starts again: the first sitting's few turns stay on record for reviewers,
 * but the conversation — greeting included — begins afresh.
 */
export function currentSitting(turns: readonly TurnRecord[]): TurnRecord[] {
  let from = 0;
  turns.forEach((t, i) => { if (t.speaker === 'agent' && t.kind === 'postponed') from = i + 1; });
  return turns.slice(from);
}

function pick<T>(items: readonly T[], seed: number): T {
  return items[Math.abs(seed) % items.length];
}

/**
 * The same question in plainer words, when "Oh" or "No" says the first wording
 * did not land. Deterministic and about the same competency, so it can be said
 * without a model call and never drifts onto a new topic.
 */
export function simplerQuestion(question: string, competencyName: string, seed: number, competencyId = ''): string {
  if (competencyId === '__process__' || competencyId === '__warmup__') {
    return pick([
      'what does a normal week look like in your current job?',
      "what's the main thing you work on in your current job right now?",
    ], seed);
  }
  const name = competencyName.trim() || 'this area';
  const options = [
    `tell me about one piece of ${name} work you did recently — what was it, and what was your part in it?`,
    `think of the last time ${name} came up in your work. What happened, and what did you do?`,
    `what does ${name} look like in your day-to-day work?`,
  ];
  const different = options.filter((o) => o.toLowerCase() !== question.toLowerCase());
  return pick(different.length ? different : options, seed);
}

// --- Acknowledgement --------------------------------------------------------------

const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'any', 'because', 'been', 'before', 'being', 'but', 'can', 'could', 'did',
  'does', 'doing', 'done', 'each', 'even', 'every', 'from', 'further', 'give', 'going', 'gone', 'good', 'have', 'having',
  'here', 'how', 'into', 'just', 'know', 'like', 'made', 'make', 'many', 'more', 'most', 'much', 'must', 'need', 'only',
  'other', 'over', 'really', 'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these',
  'they', 'thing', 'things', 'this', 'those', 'through', 'time', 'very', 'want', 'were', 'what', 'when', 'where',
  'which', 'while', 'will', 'with', 'would', 'your', 'you', 'yours', 'tell', 'mentioned', 'said', 'described', 'talked',
  'walk', 'think', 'approach', 'handle', 'decide', 'decision', 'choose', 'example', 'specific', 'describe',
]);

// A capitalised word that is only capitalised because of its position or kind.
const NOT_A_NAME = new Set(['I', 'I\'m', 'I\'ve', 'I\'d', 'I\'ll', 'The', 'A', 'An', 'We', 'My', 'Our', 'It', 'So', 'And', 'But', 'Then', 'Mostly', 'Also', 'Yes', 'No', 'Well', 'Actually', 'Basically', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

const DID_VERBS = String.raw`(?:built|led|managed|ran|run|designed|created|launched|migrated|programmed|scripted|delivered|handled|set up|owned|own|coordinated|automated|fixed|rolled out|introduced|redesigned|rebuilt|planned|wrote|write|manage|lead|coordinate|script|program)`;
const PHRASE_STOP = /\s+(?:for|with|to|and|which|that|in|on|at|so|because|but|when|while|last|this|every|from|by|using)\b.*$/i;

/**
 * The most specific thing the candidate named: a tool or product in capitals,
 * or the object of "I built / managed / scripted …". Only ever their own words,
 * so an acknowledgement built from it cannot put words in their mouth.
 */
export function salientPhrase(answer: string): string {
  const text = (answer ?? '').trim();
  if (!text) return '';
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i].replace(/[^\p{L}\p{N}'&+-]/gu, '');
    const sentenceStart = i === 0 || /[.!?]$/.test(tokens[i - 1]);
    if (!sentenceStart && /^\p{Lu}[\p{L}\p{N}&+-]{2,}$/u.test(word) && !NOT_A_NAME.has(word)) {
      const next = (tokens[i + 1] ?? '').replace(/[^\p{L}\p{N}&+-]/gu, '');
      return /^\p{Lu}[\p{L}\p{N}&+-]{2,}$/u.test(next) && !NOT_A_NAME.has(next) ? `${word} ${next}` : word;
    }
  }
  const did = new RegExp(String.raw`\b(?:i|we)\s+(?:\w+ly\s+)?${DID_VERBS}\s+((?:the|a|an|our|my)\s+)?([a-z][\w-]*(?:\s+[a-z][\w-]*){0,4})`, 'i').exec(text);
  if (did) {
    const object = did[2].replace(PHRASE_STOP, '').trim();
    if (object && !STOPWORDS.has(object.toLowerCase())) return `${did[1] ?? ''}${object}`.trim();
  }
  return '';
}

const ACK_WITH_PHRASE = [
  (p: string) => `Thanks — that's useful context on ${p}.`,
  (p: string) => `Okay, that helps me picture ${p}.`,
  (p: string) => `Thanks for the detail on ${p}.`,
  (p: string) => `Got it — ${p}, understood.`,
];

const ACK_PLAIN = [
  'Thanks for walking me through that.',
  'Okay, that makes sense.',
  'Understood, thank you.',
  'Got it, thanks.',
];

/**
 * One short sentence showing the answer was heard, before the next question.
 *
 * Neutral on purpose — never "great answer": praise is evaluation, the
 * candidate hears it as a score, and the next weaker answer then sounds like a
 * failure. Grounded in the candidate's own words where there is a phrase to
 * use; otherwise plain. Empty for anything that was not an answer.
 */
export function acknowledgement(answer: string, seed: number, previous = ''): string {
  if (detectCandidateIntent(answer).intent !== 'answer') return '';
  const phrase = salientPhrase(answer);
  // The same phrase twice running ("…on Decipher", "…on Decipher") sounds like
  // a script, so a phrase just used gives way to a plain acknowledgement.
  const usable = phrase && !previous.toLowerCase().includes(phrase.toLowerCase()) ? phrase : '';
  const options = usable ? ACK_WITH_PHRASE.map((f) => f(usable)) : ACK_PLAIN;
  const fresh = options.filter((o) => !previous.startsWith(o));
  return pick(fresh.length ? fresh : options, seed);
}

// --- Repetition -----------------------------------------------------------------

/**
 * Topics that a real interview kept returning to regardless of the role. Each
 * gets one question per interview at most, whatever the wording.
 */
const TOPICS: ReadonlyArray<{ id: string; re: RegExp }> = [
  {
    id: 'build_vs_buy',
    re: /\bbuild[- ]?(?:vs\.?|versus|or)[- ]?buy\b|\b(?:build(?:ing)?|develop(?:ing)?|custom|in[- ]house|your own)\b[^.?!]{0,70}\b(?:buy(?:ing)?|purchas\w*|off[- ]the[- ]shelf|vendor|third[- ]party|existing (?:tool|platform|product))\b|\b(?:buy(?:ing)?|purchas\w*|off[- ]the[- ]shelf|vendor|third[- ]party)\b[^.?!]{0,70}\b(?:build(?:ing)?|custom|in[- ]house|your own)\b/i,
  },
  {
    id: 'long_term_consequences',
    re: /\blong[- ](?:term|horizon|run)\b[^.?!]{0,40}\b(?:consequence|impact|effect|implication|cost)s?\b|\bsecond[- ]order\b|\bdownstream (?:consequence|effect)s?\b/i,
  },
  { id: 'architecture', re: /\barchitect(?:ure|ural|ed|ing)?\b/i },
  { id: 'organisational_change', re: /\borgani[sz]ational change\b|\bchange (?:management )?across (?:the|an|your) organi[sz]ation\b/i },
  { id: 'ten_times_scale', re: /\bten times\b|\b10x\b/i },
];

export function topicsOf(question: string): string[] {
  return TOPICS.filter((t) => t.re.test(question)).map((t) => t.id);
}

function contentStems(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? [])
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
      .map((w) => w.slice(0, 6)),
  );
}

/** Share of the smaller set's words that the other also has. */
function overlap(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const w of small) if (large.has(w)) shared += 1;
  return shared / small.size;
}

const NEAR_DUPLICATE_OVERLAP = 0.7;
const MIN_WORDS_FOR_OVERLAP = 4;

/**
 * Would this question ask about something already asked? Either a tracked
 * topic seen before, or most of its words already said in one earlier
 * question.
 */
export function isRepeatedTopic(question: string, earlier: readonly string[]): boolean {
  const topics = topicsOf(question);
  const words = contentStems(question);
  return earlier.some((prior) => {
    if (topics.some((t) => topicsOf(prior).includes(t))) return true;
    const priorWords = contentStems(prior);
    return Math.min(words.size, priorWords.size) >= MIN_WORDS_FOR_OVERLAP && overlap(words, priorWords) >= NEAR_DUPLICATE_OVERLAP;
  });
}

// --- Grounded premises ------------------------------------------------------------

const PREMISE = /\byou(?:'ve| have)?\s+(?:just\s+)?(?:mentioned|said|described|talked about|noted|told me|brought up|referred to|spoke about)\s+(?:that\s+|how\s+)?([^.?!,;—–]+)/i;

/** Share of a premise's words that must appear in what the candidate said. */
const PREMISE_GROUNDING = 0.6;

/**
 * "You mentioned X…" is allowed only if the candidate said X. A production
 * transcript built questions on premises the candidate never stated, and they
 * had to say "you got it wrong, I didn't say that". A question with no such
 * premise is always fine.
 */
export function premiseIsGrounded(question: string, candidateSaid: readonly string[]): boolean {
  const m = PREMISE.exec(question);
  if (!m) return true;
  const claimed = contentStems(m[1]);
  if (claimed.size === 0) return true;
  const said = contentStems(candidateSaid.join(' '));
  let found = 0;
  for (const w of claimed) if (said.has(w)) found += 1;
  return found / claimed.size >= PREMISE_GROUNDING;
}

// --- Answering the candidate -------------------------------------------------------

export interface RoleFacts {
  title: string;
  responsibilities: readonly string[];
  focus: readonly string[];
  durationMinutes: number;
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// Job descriptions write duties either as instructions ("Manage delivery…")
// or as nouns ("Delivery of…"); each needs its own sentence to be said aloud.
const DUTY_VERB = /^(?:manage|coordinate|oversee|lead|build|design|develop|deliver|own|drive|ensure|support|create|maintain|analy[sz]e|plan|run|write|work|collaborate|partner|define|implement|review|report|monitor|track|communicate|prepare|conduct|handle|program|script|test|execute|set|establish|identify|provide|mentor|train|negotiate|sell|advise|research|operate|administer)\b/;

function dutiesSentence(duties: readonly string[]): string {
  if (duties.every((d) => DUTY_VERB.test(d))) return `The main responsibilities are to ${listOf(duties.map((d, i) => (i === 0 ? d : `to ${d}`)))}.`;
  return `The main responsibilities include ${listOf(duties)}.`;
}

const HIRING_TEAM_WILL_COVER = "I don't have those details, but the hiring team will be happy to cover that when they follow up.";

/**
 * Answer a candidate's question from what the role actually says — its title,
 * its responsibilities, the competencies being assessed — and nothing else.
 * Anything the job description does not state (pay, location, reporting
 * lines, who owns which decision) goes to the hiring team rather than being
 * invented.
 */
export function answerFromRoleFacts(question: string, facts: RoleFacts): string {
  const q = question.toLowerCase();
  // Facts a scorecard never holds: said plainly rather than guessed.
  const notInTheRole = /\b(?:salary|pay|paid|compensation|package|ctc|benefits?|bonus|equity|location|located|remote|hybrid|office|relocat\w*|visa|notice period|start date|how big|team size|how many people)\b/.test(q);
  if (notInTheRole) return `That's a fair question. ${HIRING_TEAM_WILL_COVER}`;
  const aboutRole = /\b(?:role|position|job|looking for|hiring for|responsib\w*|day to day|day-to-day|involve|what (?:would|will) i (?:be )?do)/.test(q);
  const aboutProcess = /\b(?:next steps?|process|hear back|decision|result|outcome|feedback|when will)\b/.test(q) && !aboutRole;
  const aboutLength = /\b(?:how long|how much time|minutes|duration)\b/.test(q);
  const aboutOwnership = /\b(?:decision|decide|call|own|owner|responsible|report to|manager)\b/.test(q);

  if (aboutRole) {
    const parts = [`This is the ${facts.title} role.`];
    const duties = facts.responsibilities.slice(0, 2).map((r) => lowerFirst(r.trim().replace(/[.]+$/, '')));
    if (duties.length) parts.push(dutiesSentence(duties));
    if (facts.focus.length) parts.push(`The areas this interview focuses on are ${listOf(facts.focus)}.`);
    if (aboutOwnership) parts.push('Exactly who owns which decisions is something the hiring team can clarify when they follow up.');
    return parts.join(' ');
  }
  if (aboutLength) return `We have about ${facts.durationMinutes} minutes in total.`;
  if (aboutProcess) return 'After this, a person on the hiring team reviews the conversation and follows up with you on next steps by email.';
  return `That's a fair question. ${HIRING_TEAM_WILL_COVER}`;
}
