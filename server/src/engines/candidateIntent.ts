import { z } from 'zod';
import { detectAiIdentityQuestion, detectDistress, detectRepeatRequest, detectWithdrawal } from './policyEngine.js';

/**
 * What the candidate meant by their last turn, read BEFORE the interviewer
 * decides what to say next.
 *
 * Two production transcripts are the reason this exists. In the first, a
 * candidate asked three times to do the interview later — "can we have this
 * interview later", "I don't want", "can you cancel it, we can have it
 * sometime later" — got a new question each time, then typed "Stop" and was
 * handed a work sample. In the second, "Oh", "No", "Pause", "Nothing" and
 * "Welcome back" were each scored as an answer and followed up, and a
 * correction ("you got it wrong, I didn't say that") was ignored. The engine
 * only ever asked "what is the next question?"; it never asked "what did they
 * just say to me?".
 *
 * Deterministic and first. Short texts weigh heavily: a message that is
 * nothing but "stop" means stop, whatever else the conversation is doing,
 * while the same word inside a sentence about a project does not. An LLM
 * reading (see {@link mergeLlmIntent}) may only ADD safety on top.
 */
export type CandidateIntent =
  | 'stop'        // end the interview now
  | 'postpone'    // end now, and do it another time — without penalty
  | 'distress'    // the existing safety stop
  | 'pause'       // give me a moment; ask nothing new
  | 'resume'      // back from a pause
  | 'skip'        // explicitly move past this question
  | 'repeat'      // say it again / say it differently
  | 'correction'  // "that's not what I said"
  | 'ai_identity' // "am I talking to an AI?" and nothing else
  | 'question'    // the candidate is asking the interviewer something
  | 'non_answer'  // no content: "no", "oh", "nothing", "welcome back"
  | 'answer';

export interface IntentReading {
  intent: CandidateIntent;
  /** Which rule decided it, for tests and logs. Never shown to anyone. */
  rule: string;
}

/** Intents after which the interview is over. */
export const ENDING_INTENTS: ReadonlySet<CandidateIntent> = new Set(['stop', 'postpone', 'distress']);

/**
 * Lowercased, curly apostrophes straightened, punctuation that speech-to-text
 * and typing add inconsistently removed, whitespace collapsed. Apostrophes are
 * KEPT and matched optionally, because "dont" and "don't" both arrive.
 */
export function normalise(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/[.!?,;:…()\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(t: string): string[] {
  return t ? t.split(' ') : [];
}

// Words that pad a short message without changing what it asks for:
// "ok stop", "no, stop", "sorry, one moment", "please stop".
const FILLER = String.raw`(?:ok|okay|no|nope|please|just|yes|yeah|hey|sorry|um+|uh+|hmm+|so|well|oh|actually|right|look|and|now|then|alright)`;
const PAD = String.raw`(?:${FILLER}\s+)*`;
const TAIL = String.raw`(?:\s+(?:please|now|here|already|then|ok|okay|thanks|thank you))*`;

/** A whole message that is nothing but this, padded with filler. */
function whole(core: string): RegExp {
  return new RegExp(String.raw`^${PAD}(?:${core})${TAIL}$`);
}

// --- Stop -------------------------------------------------------------------

const STOP_WHOLE = whole(String.raw`(?:(?:stop|cancel|quit|exit|leave|end|enough)(?:\s+(?:it|this|that|now|here|the interview|the call|the session|this interview|this call|stop|please))*|that'?s enough|i quit|end this|i don'?t want(?: to)?|i do not want(?: to)?|i'?m out|no more)`);

const STOP_PHRASES: RegExp[] = [
  /\bi\s+(?:(?:want|would like|need)\s+to|wanna)\s+(?:stop|end|quit|leave|finish|cancel)\b(?!\s+(?:the|a|that|our|my|their)\s+(?!interview|call|session)\w)/,
  /\b(?:can|could|shall)\s+(?:we|you|i)\s+(?:please\s+)?(?:cancel|stop|end|quit)\b(?:\s+(?:this|it|the interview|the call|here|now|please))*\s*$/,
  /\b(?:please\s+)?(?:cancel|stop|end)\s+(?:the|this)\s+(?:interview|call|session)\b/,
  /\blet'?s\s+(?:stop|end|finish|quit)\s+(?:this|it|here|now|the interview)\b/,
  /\bi\s+(?:don'?t|do not)\s+(?:want|wanna)\s+to\s+(?:continue|carry on|go on|do this|do the interview|do this interview|do it any ?more)\b(?!\s+(?:with|using|working|to)\b(?!\s+(?:this|the interview)))/,
  /\bi'?m\s+not\s+doing\s+this\b/,
];

// --- Postpone ---------------------------------------------------------------

/** "Some other time", in the forms people actually say it. */
const LATER = String.raw`(?:later|another time|some other time|other time|another day|some other day|some ?time later|tomorrow|next week|next time|another date|a different time|a different day|some other date)`;

const POSTPONE_WHOLE = whole(String.raw`(?:(?:maybe|perhaps|can we|could we|let'?s)?\s*(?:do (?:it|this) )?${LATER}|not (?:right )?now|not today|not at the moment|reschedule|postpone|some other day|i'?m not ready|i am not ready)`);

const POSTPONE_PHRASES: RegExp[] = [
  // "can we have this interview later", "can we do it another time"
  // Anchored near the end, so "can I ask about the later stages" is not a request.
  new RegExp(String.raw`\b(?:can|could|shall|should|may)\s+(?:we|i|you)\b[^.?!]{0,50}\b${LATER}(?:\s+\S+){0,4}$`),
  // "let's do it tomorrow", "we can have it sometime later"
  new RegExp(String.raw`\b(?:let'?s|we can|we could|i can|i could|i'?d rather|i would rather|i'?d prefer to|i would prefer to)\s+(?:do|have|take|continue|finish|try)\s+(?:it|this|the interview|this interview)\b[^.?!]{0,20}\b${LATER}\b`),
  // "can we reschedule", "I need to reschedule", "please postpone"
  /\b(?:can|could|shall|should)\s+(?:we|you|i)\s+(?:please\s+)?(?:reschedule|postpone|move\s+(?:it|this|the interview))\b/,
  /\b(?:i\s+(?:need|want|would like|'?d like)\s+to|please|let'?s)\s+(?:reschedule|postpone)\b/,
  // "I don't want to take the interview right now", "I can't do this right now"
  /\bi\s+(?:don'?t|do not|can'?t|cannot|can not)\s+(?:want to\s+)?(?:do|take|have|continue|give)\s+(?:this|it|the interview|this interview|an interview)\b[^.?!]{0,20}\b(?:now|today|right now|at the moment|at this time|this time)\b/,
  // "I'm not ready (for this)", but not "the data wasn't ready"
  /^(?:\w+\s+){0,3}i'?(?:m| am)\s+not\s+ready\b(?:\s+(?:for (?:this|it|the interview|an interview)|to (?:do|take) (?:this|it|the interview)))?(?:\s+\w+){0,4}$/,
];

// --- Pause ------------------------------------------------------------------

const MOMENT = String.raw`(?:sec|second|seconds|minute|min|moment|mo|tick|break|short break|quick break)`;

const PAUSE_WHOLE = whole(String.raw`(?:pause|wait|hold on|hang on|let me think|give me (?:a|one) ${MOMENT}|(?:just |wait )?(?:a|one) ${MOMENT}|(?:wait|hold on|hang on) (?:a|one) ${MOMENT}|(?:can|could) (?:we|i) (?:please )?(?:pause|take a ${MOMENT}|have a ${MOMENT}|get a ${MOMENT})|i need a ${MOMENT}|just a ${MOMENT}|one moment please)`);

const PAUSE_PHRASES: RegExp[] = [
  new RegExp(String.raw`^(?:\w+\s+){0,2}(?:can|could)\s+(?:we|i)\s+(?:please\s+)?(?:pause|take\s+a\s+${MOMENT}|have\s+a\s+${MOMENT}|get\s+a\s+${MOMENT})\b`),
  new RegExp(String.raw`^(?:\w+\s+){0,2}(?:give\s+me|i\s+need)\s+(?:a|one)\s+${MOMENT}\b`),
];

// --- Resume / skip / repeat / non-answer ----------------------------------------

const RESUME_WHOLE = whole(String.raw`(?:(?:i'?m |i am )?ready(?: now)?|i'?m back|i am back|back|let'?s (?:continue|go|carry on|go on|resume)|continue|go ahead|carry on|go on|resume|you can continue)`);

const SKIP_WHOLE = whole(String.raw`(?:skip(?: (?:it|this|this one|that|that one|this question|the question))?|pass|i pass|i'?ll pass|next|next question|(?:can we |let'?s )?move on|(?:can we |let'?s )?go to the next (?:one|question)|i'?d rather not (?:answer|say)(?: (?:that|this))?|i would rather not (?:answer|say)(?: (?:that|this))?|i (?:don'?t|do not) want to answer(?: (?:that|this|it|this one|that one))?|i'?d prefer not to (?:answer|say)(?: (?:that|this))?)`);

const REPEAT_WHOLE = whole(String.raw`(?:rephrase(?: (?:it|that|please))?|(?:can|could) you rephrase(?: (?:it|that|the question))?|what do you mean|what does that mean|i (?:don'?t|do not) understand(?: (?:the|your) question| what you mean)?|i didn'?t (?:understand|get|catch)(?: (?:that|it|the question|what you said))?|say (?:it|that) again|one more time|again)`);

// A message that carries no answer at all. Whole-message only: "No, in that
// project I owned the programming" is an answer that happens to start with no.
const NON_ANSWER_WHOLE = whole(String.raw`(?:no|nope|nah|nothing|nothing really|nothing much|none|oh|ah|ooh|hmm+|hm+|um+|uh+|er+|erm|ok|okay|yes|yeah|yep|sure|right|fine|alright|cool|i see|got it|i don'?t know|i do not know|i dont know|idk|dunno|no idea|not sure|i'?m not sure|i am not sure|i have no idea|i don'?t remember|i can'?t remember|i can'?t think of (?:anything|one|any)|nothing comes to mind|welcome back|hello|hi|hey|hello there|can you hear me|are you there|is this working|thank you|thanks|sorry|mm+|huh)(?:\s+(?:no|yes|ok|okay|oh|hmm|sorry|thanks))*`);

// --- Correction ---------------------------------------------------------------

const CORRECTION_PHRASES: RegExp[] = [
  /\byou\s+(?:got\s+(?:it|that|me|this)\s+wrong|(?:have\s+)?misunderstood(?:\s+me)?|misheard(?:\s+me)?|(?:are\s+)?mistaken)\b/,
  /\bthat'?s\s+not\s+what\s+i\s+(?:said|meant|mean|was saying)\b/,
  /\bthat\s+is\s+not\s+what\s+i\s+(?:said|meant)\b/,
  /\bi\s+(?:didn'?t|did not|never)\s+(?:say|said|mention|mentioned)\s+(?:that|this|it|anything like that)\b/,
  /\bthat'?s\s+not\s+(?:right|correct|true|accurate)\b[^.?!]{0,10}$/,
];

// --- Questions to the interviewer ------------------------------------------------

const ASKED_OF_INTERVIEWER: RegExp[] = [
  /^(?:\w+\s+){0,3}(?:can|could|may)\s+i\s+ask\b/,
  /^(?:\w+\s+){0,2}(?:i have a|quick|one)\s+question\b/,
  /\bwhat\s+(?:exact(?:ly)?\s+|kind of\s+|type of\s+|sort of\s+)?(?:role|position|job)\s+(?:are you|is this|is it)\b/,
  /\bwhat\s+(?:are you|is the team|is the company)\s+(?:looking for|hiring for)\b/,
  // Needs a question's grammar at the start: "When I joined the team…" is an answer.
  /^(?:\w+\s+){0,2}(?:(?:what|how|who|where|when|which|why)(?:\s+\w+)?\s+(?:is|are|does|do|will|would|can|could)|(?:is|are|does|do|will|would|can|could)\s+(?:this|the|there|it|you|i|we))\b[^.?!]{0,80}\b(?:this role|the role|this position|the position|this job|the job|the team|your team|the company|your company|the process|next steps?|the salary|salary|remote|hybrid|report to|the interview|this interview|the hiring)\b/,
];

/** Ends with a question mark, or reads as one addressed to the interviewer. */
function isQuestionToInterviewer(raw: string, t: string): boolean {
  if (words(t).length > 60) return false;
  const addressed = ASKED_OF_INTERVIEWER.some((re) => re.test(t));
  if (addressed) return true;
  // A plain question mark counts only when it is also short and asked of us:
  // "What did I do? I rebuilt the quota logic" is an answer, not a question.
  return /\?\s*$/.test(raw.trim()) && words(t).length <= 20 && /\b(?:you|your|this|the)\b/.test(t) && !/\bi\s+(?:built|did|led|ran|managed|owned|used|made)\b/.test(t);
}

/** Words after a question that make the turn an answer too: "Are you an AI? Anyway, I built…". */
const ANSWER_AFTER_QUESTION_WORDS = 4;
/** Without punctuation (speech), a turn this short is only the question. */
const QUESTION_ONLY_MAX_WORDS = 8;

function answersAfterQuestion(raw: string, t: string): boolean {
  const at = raw.indexOf('?');
  if (at < 0) return words(t).length > QUESTION_ONLY_MAX_WORDS;
  return words(normalise(raw.slice(at + 1))).length >= ANSWER_AFTER_QUESTION_WORDS;
}

/**
 * Read the candidate's turn. Pure and synchronous: the same text always gives
 * the same reading, so the director can recompute it from the transcript
 * instead of the reading having to be stored.
 */
export function detectCandidateIntent(text: string): IntentReading {
  const raw = (text ?? '').replace(/[’‘]/g, "'");
  const t = normalise(raw);
  if (!t) return { intent: 'non_answer', rule: 'empty' };

  const postpone = POSTPONE_WHOLE.test(t) || POSTPONE_PHRASES.some((re) => re.test(t));
  const stop = STOP_WHOLE.test(t) || STOP_PHRASES.some((re) => re.test(t)) || detectWithdrawal(raw);
  const distress = detectDistress(raw);

  // A request to do it later is also a request to stop now; the difference is
  // only what happens next, and "later" is the more precise of the two. Distress
  // outranks "later" (the person needs a human now), and an explicit stop with
  // distress keeps the long-standing rule that stopping wins.
  if (postpone && !distress) return { intent: 'postpone', rule: 'postpone' };
  if (stop) return { intent: 'stop', rule: 'stop' };
  if (distress) return { intent: 'distress', rule: 'distress' };

  if (PAUSE_WHOLE.test(t) || PAUSE_PHRASES.some((re) => re.test(t))) return { intent: 'pause', rule: 'pause' };
  if (SKIP_WHOLE.test(t)) return { intent: 'skip', rule: 'skip' };
  if (RESUME_WHOLE.test(t)) return { intent: 'resume', rule: 'resume' };
  if (CORRECTION_PHRASES.some((re) => re.test(t))) return { intent: 'correction', rule: 'correction' };
  if (REPEAT_WHOLE.test(t) || detectRepeatRequest(raw)) return { intent: 'repeat', rule: 'repeat' };
  // Only when that is all they said. "Are you an AI? Anyway, I built…" is an
  // answer with a question attached; the identity answer is prefixed to the
  // reply either way (conversationRuntime nextUtterance).
  if (detectAiIdentityQuestion(raw) && !answersAfterQuestion(raw, t)) return { intent: 'ai_identity', rule: 'ai_identity' };
  if (isQuestionToInterviewer(raw, t)) return { intent: 'question', rule: 'question' };
  if (NON_ANSWER_WHOLE.test(t)) return { intent: 'non_answer', rule: 'non_answer' };
  // Nothing but punctuation, or a single stray syllable.
  if (!/[a-z0-9]{2,}/.test(t)) return { intent: 'non_answer', rule: 'no_words' };
  return { intent: 'answer', rule: 'answer' };
}

/** Intents whose turn is not an answer to the question and must not be counted or scored as one. */
const NOT_AN_ANSWER: ReadonlySet<CandidateIntent> = new Set([
  'stop', 'postpone', 'distress', 'pause', 'resume', 'skip', 'repeat', 'correction', 'ai_identity', 'question', 'non_answer',
]);

/** Whether this candidate turn is an answer to the question — evidence, not conversation management. */
export function isSubstantiveAnswer(text: string): boolean {
  return !NOT_AN_ANSWER.has(detectCandidateIntent(text).intent);
}

// --- LLM reading ---------------------------------------------------------------

/**
 * The shape an LLM must return. Strict, so a model that improvises a field or
 * an intent outside this list is treated as having said nothing.
 */
export const llmIntentSchema = z.object({
  intent: z.enum(['stop', 'postpone', 'pause', 'answer', 'other']),
  confidence: z.number().min(0).max(1),
}).strict();

export type LlmIntent = z.infer<typeof llmIntentSchema>;

/** Below this the model's reading is ignored: a false stop ends a real interview. */
export const LLM_INTENT_MIN_CONFIDENCE = 0.8;

/** The deterministic readings an LLM may upgrade. Everything else is already decided. */
const UPGRADABLE: ReadonlySet<CandidateIntent> = new Set(['answer', 'non_answer', 'question', 'resume', 'skip']);

/**
 * Combine the deterministic reading with the model's.
 *
 * One-directional on purpose: the model can catch a stop or a postponement the
 * patterns missed ("honestly I'd prefer we pick this up once my exams are
 * over"), and a pause, but it can never turn a deterministic stop, postponement
 * or distress into anything else, nor turn an answer into a non-answer. Losing
 * a stop is the failure the owner saw in production; the model is there to
 * make that rarer, never likelier.
 */
export function mergeLlmIntent(deterministic: IntentReading, llm: LlmIntent | null): IntentReading {
  if (!llm || !UPGRADABLE.has(deterministic.intent)) return deterministic;
  if (llm.confidence < LLM_INTENT_MIN_CONFIDENCE) return deterministic;
  if (llm.intent === 'stop' || llm.intent === 'postpone') return { intent: llm.intent, rule: `llm_${llm.intent}` };
  if (llm.intent === 'pause' && deterministic.intent !== 'answer') return { intent: 'pause', rule: 'llm_pause' };
  return deterministic;
}
