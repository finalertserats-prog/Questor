import { z } from 'zod';
import {
  ASKED_OF_US, ENDS_HERE, detectAiIdentityQuestion, detectDistress, detectHumanRequest,
  detectInjection, detectRepeatRequest, detectWithdrawal,
} from './policyEngine.js';

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
  | 'human_request' // "can I do this with a person instead?" — the consent page's promise

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
  /**
   * An ending cue the patterns are NOT sure about.
   *
   * Three rounds of tightening and loosening these patterns taught the same
   * lesson each time: a binary decision is the wrong shape. Tighten them and a
   * real request to leave is answered with another question; loosen them and an
   * interview ends because the candidate said "later" about a pipeline. So an
   * utterance now lands in one of three tiers — clearly ending, clearly about
   * the work, or unclear — and an unclear one is neither acted on nor ignored:
   * the interviewer asks one short question and waits (conversationRuntime).
   * A false alarm then costs a polite question instead of someone's interview.
   */
  unclear?: 'stop' | 'postpone';
}

/** Intents after which the interview is over. */
export const ENDING_INTENTS: ReadonlySet<CandidateIntent> = new Set(['stop', 'postpone', 'distress', 'human_request']);

/**
 * Lowercased, curly apostrophes straightened, punctuation that speech-to-text
 * and typing add inconsistently removed, whitespace collapsed. Apostrophes are
 * KEPT and matched optionally, because "dont" and "don't" both arrive.
 *
 * Note what this costs the patterns below: sentence-ending punctuation is gone
 * by the time any of them runs, so a window written as `[^.?!]{0,N}` is a
 * LENGTH bound and nothing more — it cannot hold a match inside one sentence,
 * because there is no sentence left to be inside. Speech-to-text supplies no
 * punctuation for half the turns anyway, so a pattern that needs to stay inside
 * a clause has to say so structurally — by naming what may follow the cue, the
 * way {@link ENDS_HERE} and RESUME_OBJECT do — rather than by leaning on a
 * boundary that is not there.
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
  // The verb has to end the sentence or name the interview: "I need to stop
  // using Excel for tracker delivery" is a candidate describing their work.
  new RegExp(String.raw`\bi\s+(?:(?:want|would like|need)\s+to|wanna)\s+(?:stop|end|quit|leave|finish|cancel)${ENDS_HERE}`),
  /\b(?:can|could|shall)\s+(?:we|you|i)\s+(?:please\s+)?(?:cancel|stop|end|quit)\b(?:\s+(?:this|it|the interview|the call|here|now|please))*\s*$/,
  // "I had to cancel the session with the client because the data was late" is
  // a project, not a request: naming the interview is not enough on its own
  // when "call" and "session" are also ordinary nouns. See ASKED_OF_US.
  new RegExp(String.raw`${ASKED_OF_US}(?:cancel|stop|end)\s+(?:the|this)\s+(?:interview|call|session)\b`),
  /\blet'?s\s+(?:stop|end|finish|quit)\s+(?:this|it|here|now|the interview)\b/,
  /\bi\s+(?:don'?t|do not)\s+(?:want|wanna)\s+to\s+(?:continue|carry on|go on|do this|do the interview|do this interview|do it any ?more)\b(?!\s+(?:with|using|working|to)\b(?!\s+(?:this|the interview)))/,
  /\bi'?m\s+not\s+doing\s+this\b/,
  // "stop, I need to go" — the stop word opens the message as its own clause,
  // and what follows is the reason for it, not its object. Anchored at the
  // start, so "we had to stop the project because…" and "I need to stop using
  // Excel because…" stay what they are: talk about the work.
  new RegExp(String.raw`^${PAD}(?:stop|cancel|quit|enough|no more)(?:\s+(?:please|now|here|it|this))*\s+(?:i\b|we\b|my\b|our\b|something\b|someone\b|there'?s|it'?s|sorry\b|because i\b|since i\b)\b`),
];

/**
 * Adverbs that can only be modifying the leaving: "I have to go soon" is still
 * a goodbye, and ENDS_HERE has no room for it. Kept short on purpose — anything
 * that could open a noun phrase would undo the guard it sits inside.
 */
const LEAVING_SOON = String.raw`(?:\s+(?:soon|early|right away|in a (?:bit|minute|moment|sec|second)))?`;

/**
 * The reason someone gives in the same breath as the request — "I have to go,
 * my manager is calling", "can we reschedule, something's come up".
 *
 * ENDS_HERE can close on a comma, but by the time these patterns run the comma
 * is gone (see {@link normalise}), so a reason has to be recognised by its own
 * shape rather than by the punctuation that introduced it. A reason is a clause
 * with a subject and a verb of its own; an object is a noun phrase with no verb
 * at all. That difference is the whole guard: it admits "my manager is calling"
 * and keeps out "the numbers", "the route plan past the transport manager" and
 * every other thing a candidate has to run before Friday.
 */
const A_REASON_FOLLOWS = String.raw`(?:\s+(?:because|since|sorry|i|we|something|someone|there'?s|it'?s)\b|\s+(?:my|our|the)\s+\w+(?:'?s)?\s+(?:is|was|are|were|has|have|just|needs?|starts?|started|calls?|called|calling|wants?|arrived|woke)\b)`;

/** The request is all that is being asked: it closes the utterance, or its reason follows. */
const ENDS_OR_EXPLAINS = String.raw`(?:${ENDS_HERE}|${A_REASON_FOLLOWS})`;

/**
 * "I need to go." Said plainly, at the start of the turn, this is as clear an
 * ending as "stop" — and it was reaching only the model, which production
 * cannot call. Anchored to the opening of the utterance, so "the client can't
 * continue with the project" stays a sentence about the work.
 */
const MUST_GO = new RegExp(
  String.raw`^(?:(?:${FILLER}|really|honestly|unfortunately|i'?m afraid)\s+)*`
  + String.raw`(?:i\s+(?:really\s+)?|i'?ve\s+)(?:`
  // "Go" and "run" are two of the busiest verbs in working English, and this
  // alternative ended on a bare word boundary: "I need to go back to 2019 to
  // explain how the schema ended up that way" and "I have to run the numbers
  // first" were read as somebody leaving. The leaving has to be the whole of
  // what is said — an object after the verb means it is a different verb.
  + String.raw`(?:need|have|'?ve got|ve got|got|gotta|must)\s*(?:to\s+)?(?:go|leave|head off|jump off|run|log off|drop off|get going)${LEAVING_SOON}${ENDS_OR_EXPLAINS}`
  // Left on a word boundary deliberately: "I can't carry on like this" and "I
  // can't go on much longer" are real withdrawals that no ending guard would
  // keep, and none of these objects doubles as work talk the way "go" does.
  + String.raw`|(?:can'?t|cannot|can not)\s+(?:continue|carry on|go on|stay|keep going|do this)\b`
  + String.raw`)`,
);

// --- Postpone ---------------------------------------------------------------

/** "Some other time", in the forms people actually say it. */
const LATER = String.raw`(?:later|another time|some other time|other time|another day|some other day|some ?time later|tomorrow|next week|next time|another date|a different time|a different day|some other date)`;

/**
 * The other half of "later": a time named by the thing that has to happen
 * first. Candidates say "after my exams", "once my shift is over", "when I'm
 * free" far more often than "at another time", and every one of these was
 * reaching only the model — so with no model configured (or a call that times
 * out) the interviewer asked its next question instead of stopping, which is
 * the production failure this whole layer exists to prevent.
 */
const LATER_EVENT = String.raw`(?:(?:after|once)\s+(?:my |the |our |this )?(?:exams?|class(?:es)?|lecture|work|shift|meeting|lunch|break|call|holiday|trip|weekend|appointment)\w*(?:\s+(?:is|are)\s+(?:over|done|finished))?|when i(?:'?m| am) free|when i(?:'?m| am) done|in (?:an hour|a bit|a while|half an hour|\d+ (?:minutes|mins|hours|days)))`;

/** Either way of naming a later time. */
const TIME_LATER = String.raw`(?:${LATER}|${LATER_EVENT})`;

/** Verbs for taking the interview up again — "come back", "pick this up", "do it". */
const RESUME_VERB = String.raw`(?:come back(?!\s+to\s+(?:that|the|those|it\b))|pick (?:this|it) (?:up|back up)|get back to (?:this|it)|continue|carry on|finish (?:this|it)|do (?:it|this|the interview)|have (?:it|this|the interview)|take (?:it|this|the interview)|try (?:this|it) again)`;

/**
 * What may sit between the resume verb and the time: this interview, or
 * nothing.
 *
 * It used to be fifty characters of anything, which is how "on the migration
 * I'll continue the backfill tomorrow, my colleague covers the weekend" became
 * a request to reschedule and ended the interview. "Continue" and "carry on"
 * take a bare object, so without this the pattern reads any object at all as
 * the interview — and a competency answer is made of objects.
 */
const RESUME_OBJECT = String.raw`(?:\s+(?:with\s+)?(?:this|it|that|the interview|this interview|the call|the session))?`;

const POSTPONE_WHOLE = whole(String.raw`(?:(?:maybe|perhaps|can we|could we|let'?s)?\s*(?:do (?:it|this) )?${LATER}|not (?:right )?now|not today|not at the moment|reschedule|postpone|some other day|i'?m not ready|i am not ready)`);

/**
 * What may follow the time and still be the same request: politeness, and
 * nothing else.
 *
 * It used to allow any four words, which made "I'll do it later in the
 * pipeline" and "I'll pick this up after the holidays with the client" read as
 * requests to end the interview. A candidate asking for another time stops
 * there; a candidate describing their work carries on into the sentence.
 */
const POLITE = String.raw`(?:\s+(?:please|thanks|thank you|if possible|if that'?s ok(?:ay)?|if that works|if you don'?t mind|if we can|if that'?s fine|ok(?:ay)?|alright|yeah|yes))*`;

/**
 * The reason people give for asking — "…because my manager just called", "…,
 * I'm on a client call", "…, my exam starts in ten minutes".
 *
 * Deliberately a short list of clause openers rather than "any words": it is
 * what separates a request with a reason from "I'll do it later in the
 * pipeline", where the sentence simply carries on about the work.
 */
const REASON_TAIL = String.raw`(?:\s+(?:because|since|as|due to|cos|coz|i'?m|i am|i'?ve|i have|i need|i'?ll need|i got|i have got|my|our|something|someone|there'?s|it'?s|the baby|sorry)\b.{0,70})?`;

/** What may follow the time and still be the same request: politeness, a reason, or nothing. */
const REQUEST_TAIL = String.raw`${POLITE}${REASON_TAIL}${POLITE}\s*$`;

/**
 * What may come before the request: the reason again, on the other side of it
 * ("sorry, my manager just called, can we do this later?"). Bounded rather
 * than unlimited, and reported speech is excluded separately, so a story about
 * what a client asked for is still a story.
 */
const REQUEST_LEAD = String.raw`^(?:\w+\s+){0,12}`;

/** Ways of opening a request of one's own: "I'd prefer we…", "I'd like to…", "I'll…". */
const REQUEST_OPENER = String.raw`(?:let'?s|we can|we could|i can|i could|i'?ll|i will|i'?d (?:rather|prefer|like)(?:\s+(?:to|we))?|i would (?:rather|prefer|like)(?:\s+(?:to|we))?)`;

const POSTPONE_PHRASES: RegExp[] = [
  // "can we have this interview later", "can we do it another time",
  // "can we continue after class", "can I come back once my exams are over".
  // Anchored at both ends: the candidate's own request, and nothing after the
  // time but politeness.
  new RegExp(String.raw`${REQUEST_LEAD}(?:can|could|shall|should|may)\s+(?:we|i|you)\b[^.?!]{0,50}\b${TIME_LATER}${REQUEST_TAIL}`),
  // "let's do it tomorrow", "I'll do it later", "I can come back after exams",
  // "honestly I'd prefer we pick this up once my exams are over".
  new RegExp(String.raw`${REQUEST_LEAD}${REQUEST_OPENER}\s+${RESUME_VERB}${RESUME_OBJECT}\s+${TIME_LATER}${REQUEST_TAIL}`),
  // "could we pick this up once my exams are over" — the request verb carries
  // it even when the time marker is the only thing after it.
  new RegExp(String.raw`${REQUEST_LEAD}(?:can|could|shall|may)\s+(?:we|i)\s+${RESUME_VERB}${RESUME_OBJECT}\s+${TIME_LATER}${REQUEST_TAIL}`),
  // "can we reschedule", "I need to reschedule", "please postpone".
  // Rescheduling is also half of every delivery job there is, so the verb has
  // to end the request: "could we reschedule the workshop, I asked them" and "I
  // need to reschedule the client demo whenever a release slips" are answers.
  // A time said out loud ("can we reschedule for tomorrow") is caught above.
  new RegExp(String.raw`\b(?:can|could|shall|should)\s+(?:we|you|i)\s+(?:please\s+)?(?:reschedule|postpone|move\s+(?:it|this|the interview))${ENDS_OR_EXPLAINS}`),
  new RegExp(String.raw`\b(?:i\s+(?:need|want|would like|'?d like)\s+to|please|let'?s)\s+(?:reschedule|postpone)${ENDS_OR_EXPLAINS}`),
  // "I don't want to take the interview right now", "I can't do this right now"
  /\bi\s+(?:don'?t|do not|can'?t|cannot|can not)\s+(?:want to\s+)?(?:do|take|have|continue|give)\s+(?:this|it|the interview|this interview|an interview)\b[^.?!]{0,20}\b(?:now|today|right now|at the moment|at this time|this time)\b/,
  // "I'm not ready (for this)", but not "the data wasn't ready"
  /^(?:\w+\s+){0,3}i'?(?:m| am)\s+not\s+ready\b(?:\s+(?:for (?:this|it|the interview|an interview)|to (?:do|take) (?:this|it|the interview)))?(?:\s+\w+){0,4}$/,
  // "I'm not free right now, later?" — said about themselves, near the whole message.
  /^(?:\w+\s+){0,3}i'?(?:m| am)\s+not\s+(?:free|available)\b(?:\s+\w+){0,6}$/,
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

// Somebody else's request, reported: "the client asked if we could pick this
// up after work" and "I asked the client, can we do this later…" are stories
// about a project, not a candidate asking to leave.
const REPORTED_SPEECH = /\b(?:client|customer|team|manager|vendor|stakeholder|lead|boss|recruiter|sponsor|they|he|she)\b[^.?!]{0,30}\b(?:asked|said|told|wanted|suggested|requested|preferred)\b|\b(?:i|we)\s+(?:asked|told|emailed|called|checked with|said to|spoke to|pushed back on)\s+(?:the\s+|our\s+|my\s+)?(?:client|customer|team|manager|vendor|stakeholder|lead|boss|recruiter|sponsor|them|him|her)\b/;

// …unless the candidate's own request opens the message, in which case whatever
// they go on to report about a client does not take it away from them.
const OWN_REQUEST_FIRST = /^(?:\w+\s+){0,2}(?:can|could|shall|may|let'?s|i'?ll|i will|i'?d|i would)\b/;

function isReportedRequest(t: string): boolean {
  return REPORTED_SPEECH.test(t) && !OWN_REQUEST_FIRST.test(t);
}

// --- The three tiers ---------------------------------------------------------

/**
 * TIER 2, CLEARLY ABOUT THE WORK. The ending word is a verb with an object, or
 * the subject of the sentence is the work, or somebody else's request is being
 * reported, or the time word belongs to a phrase about a project. These are
 * answers, silently — no confirming question, nothing for the candidate to
 * notice.
 */
const CUE_WITH_OBJECT = /\b(?:stop|stops|stopped|stopping|end|ends|ended|ending|cancel|cancels|cancell?ed|pause|pauses|paused|quit)\s+(?!(?:please|now|here|already|then|sorry|i|we|my|our|because|since|and|but|so|soon|later|today|tomorrow|tonight|early|for|at|in|when|if|before|after|until|there|right)\b)(?:the|this|that|a|an|our|my|their|its|all|any|it|them|those|these)?\s*[a-z][a-z'-]*/;

/** "wrap up the fieldwork" is an action on the work, not on this interview. */
const WRAP_UP_WORK_OBJECT = /\bwrap\s+up\s+(?!(?:this|it|here|now|soon|please|the interview|the call|the session)\b)(?:the|this|that|a|an|our|my|their|its)?\s*[a-z][a-z'-]*/;

/** "The survey stops when the quota is full" — the thing stopping is the work. */
const WORK_STOPS = /\b(?:the|our|my|this|that|a|an|each|every)\s+[a-z][a-z'-]*\s+(?:stops?|ends?|pauses?|finishes|finished|stopped|ended)\b/;

/** "Later we moved to Qualtrics", "we rescheduled the fieldwork" — past, and done. */
const NARRATIVE_CUE = /\b(?:later|afterwards|then|eventually)\s+(?:we|i|they|it|the team)\s+\w+(?:ed|ame|ent|ot)\b|\b(?:we|i|they)\s+(?:rescheduled|postponed|paused|stopped|ended|cancell?ed|delayed|replanned)\b/;

/** "later in the pipeline", "after the holidays with the client" — the time belongs to the work. */
const CUE_IN_WORK_PHRASE = /\b(?:later|tomorrow|next week|another day|another time)\s+(?:in|on|at|during|within|for|with|alongside|across|of)\b|\bafter\s+(?:the\s+|my\s+|our\s+)?\w+\s+(?:with|for|in|on|at|alongside)\b/;

function isClearlyAboutTheWork(t: string): boolean {
  return REPORTED_SPEECH.test(t) || CUE_WITH_OBJECT.test(t) || WRAP_UP_WORK_OBJECT.test(t) || WORK_STOPS.test(t) || NARRATIVE_CUE.test(t) || CUE_IN_WORK_PHRASE.test(t);
}

/**
 * TIER 3, UNCLEAR. A hedged ending — "I might have to stop soon", "maybe
 * another time would be better" — where the candidate has not actually asked
 * for anything. Deliberately narrow: every one of these costs the candidate a
 * confirming question, so it covers hedges about ending rather than every
 * mention of "later".
 */
const HEDGED_STOP = /\b(?:i|we)\b[^.?!]{0,40}\b(?:might|may|maybe|probably|not sure|think i|feel like|should|may have|might have)\b[^.?!]{0,40}\b(?:stop|stopping|leave|go|wrap (?:this|it) up|wrap up|quit|end|call it|keep going)\b(?:\s+(?:soon|now|here|today|early|please|probably|maybe|then))*$/;

const HEDGED_POSTPONE = /\b(?:maybe|perhaps|might|may|possibly|probably|i wonder)\b[^.?!]{0,40}\b(?:another time|later|tomorrow|next week|another day|reschedul\w*|postpone)\b|\b(?:another time|later|tomorrow|next week|another day)\b[^.?!]{0,40}\b(?:might|may|would|could)\b[^.?!]{0,25}\b(?:be better|be easier|work|suit|help)\b/;

/** Past this length a turn is an answer that mentions something, not a hedged request. */
const MAX_WORDS_FOR_UNCLEAR = 25;

/** Which ending the utterance hints at without asking for it, if any. */
function unclearCue(t: string): 'stop' | 'postpone' | null {
  if (words(t).length > MAX_WORDS_FOR_UNCLEAR) return null;
  if (HEDGED_STOP.test(t)) return 'stop';
  if (HEDGED_POSTPONE.test(t)) return 'postpone';
  return null;
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

  // TIER 1, CLEARLY ENDING: acted on immediately, with no model and no
  // confirming question.
  const postpone = POSTPONE_WHOLE.test(t) || (!isReportedRequest(t) && POSTPONE_PHRASES.some((re) => re.test(t)));
  const stop = STOP_WHOLE.test(t) || STOP_PHRASES.some((re) => re.test(t)) || MUST_GO.test(t) || detectWithdrawal(raw);
  const distress = detectDistress(raw);
  // Asked for a person. Read before the two ways of ending, because it is the
  // more precise reading of the same turn: "I'd rather not carry on with this,
  // can someone from your team pick it up?" is a stop AND a request, and only
  // the request says what has to happen next. Not read from an injected turn:
  // instruction-like text must never be able to steer the ending either.
  const humanRequest = !isReportedRequest(t) && !detectInjection(raw).injection && detectHumanRequest(raw);

  // A request to do it later is also a request to stop now; the difference is
  // only what happens next, and "later" is the more precise of the two. Distress
  // outranks "later" (the person needs a human now), and an explicit stop with
  // distress keeps the long-standing rule that stopping wins.
  if (humanRequest && !distress) return { intent: 'human_request', rule: 'human_request' };
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

  // TIER 2 / TIER 3. An answer that carries a hedged ending is still an answer
  // — it usually has content worth scoring — but the interviewer asks about it
  // before choosing the next question.
  if (!isClearlyAboutTheWork(t)) {
    const cue = unclearCue(t);
    if (cue) return { intent: 'answer', rule: `unclear_${cue}`, unclear: cue };
  }
  return { intent: 'answer', rule: 'answer' };
}

/** Intents whose turn is not an answer to the question and must not be counted or scored as one. */
const NOT_AN_ANSWER: ReadonlySet<CandidateIntent> = new Set([
  'stop', 'postpone', 'distress', 'human_request', 'pause', 'resume', 'skip', 'repeat', 'correction', 'ai_identity', 'question', 'non_answer',
]);

const BARE_YES = whole(String.raw`(?:yes|yeah|yep|yup|sure|correct|that'?s right|absolutely|definitely|of course)`);
const BARE_NO = whole(String.raw`(?:no|nope|nah|not really|never|negative)`);

/**
 * A turn that is nothing but "yes" or "no".
 *
 * Meaningless on its own, and a real answer to "did you write the scripts
 * yourself?" — so the caller decides, knowing what was asked (see
 * conversationModel isAnswerInContext). Treating it as empty everywhere
 * rephrased a question the candidate had just answered and dropped the answer
 * from the evidence a reviewer reads.
 */
export function bareYesNo(text: string): 'yes' | 'no' | null {
  const t = normalise(text);
  if (!t) return null;
  if (BARE_YES.test(t)) return 'yes';
  if (BARE_NO.test(t)) return 'no';
  return null;
}

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
  // `human_request` is in the model's vocabulary as well as the patterns':
  // the patterns are the floor (they are all production has when no provider
  // answers), and the model is the net for the phrasing nobody predicted.
  intent: z.enum(['stop', 'postpone', 'pause', 'human_request', 'answer', 'other']),
  confidence: z.number().min(0).max(1),
}).strict();

export type LlmIntent = z.infer<typeof llmIntentSchema>;

/** Below this the model's reading is ignored: a false stop ends a real interview. */
export const LLM_INTENT_MIN_CONFIDENCE = 0.8;

/** The deterministic readings an LLM may upgrade. Everything else is already decided. */
const UPGRADABLE: ReadonlySet<CandidateIntent> = new Set(['answer', 'non_answer', 'question', 'resume', 'skip', 'stop']);

/**
 * A deterministic `stop` is already decided — except in one direction. "I don't
 * want to carry on with this" reads as a stop and is often the opening half of
 * "…can someone from your team take over", and the difference between the two
 * is whether a person ever calls the candidate back. So a stop may become a
 * human request and nothing else: it still ends the interview, and it ends it
 * the way the consent page promised.
 */
const ONLY_UPGRADE_FROM_STOP: CandidateIntent = 'human_request';

/**
 * Whether asking a model about this turn could change anything. A stop, a
 * postponement or a pause the patterns already caught is decided: asking costs
 * a call and a second of a candidate's time to be told what we know.
 */
export function couldBeUpgraded(reading: IntentReading): boolean {
  return UPGRADABLE.has(reading.intent);
}

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
  // A request for a person outranks the other two upgrades: it says what has to
  // happen next, where "stop" only says that something must.
  if (llm.intent === 'human_request') return { intent: 'human_request', rule: 'llm_human_request' };
  if (deterministic.intent === 'stop' && llm.intent !== ONLY_UPGRADE_FROM_STOP) return deterministic;
  if (llm.intent === 'stop' || llm.intent === 'postpone') return { intent: llm.intent, rule: `llm_${llm.intent}` };
  if (llm.intent === 'pause' && deterministic.intent !== 'answer') return { intent: 'pause', rule: 'llm_pause' };
  return deterministic;
}
