// Policy & guardrail engine (BRD FR-023, Section 16.5, 17).
// - Blocks/rewrites prohibited questions (protected-trait inference).
// - Detects prompt-injection attempts in candidate speech.
// - Validates model output before it is spoken or scored.
// Deterministic and always-on; no external dependency.

export interface PolicyResult {
  allowed: boolean;
  rewritten?: string;
  violations: string[];
  category?: string;
}

/**
 * Characteristics an interviewer must never ask about or infer. The common core
 * of US, UK, EU and Indian employment law rather than one country's list: the
 * live prompt and a new role's default prohibited topics both use it, and the
 * patterns below are its deterministic backstop.
 */
export const PROTECTED_TOPICS = [
  'age', 'race', 'ethnicity', 'colour', 'sex', 'gender', 'gender identity', 'sexual orientation',
  'pregnancy', 'marital status', 'family status', 'disability', 'health', 'religion', 'national origin',
  'nationality', 'caste', 'political views',
] as const;

// Protected / prohibited topics — must never be asked or inferred. Each pattern
// is aimed at the candidate ("your race", "what gender are you"), so ordinary
// work words — a race condition, a colour palette, a gender field — pass.
const PROHIBITED_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: /\b(how old are you|your age|date of birth|year of birth|(when|what year|which year) were you born)\b/i, category: 'age' },
  { re: /\b(what race|your race|race are you|ethnicity|ethnic (background|origin|group)|skin (colou?r|tone))\b/i, category: 'race_colour' },
  { re: /\b(are you (a )?(man|woman|male|female)|your (gender|sex)|what (gender|sex) are you|transgender|gender identity|identify as (a )?(man|woman|male|female|trans))\b/i, category: 'sex_gender' },
  { re: /\b(pregnan\w*|(planning|plan) (to have|on having) (kids|children|a baby|a family)|start a family|maternity plans)\b/i, category: 'pregnancy' },
  { re: /\b(are you married|marital status|spouse|children|do you have (any )?kids|family plan\w*)\b/i, category: 'family_status' },
  { re: /\b(what (religion|caste)|your religion|which caste|your caste|community do you belong|religious beliefs|do you (go to|attend) (church|mosque|temple|synagogue|gurdwara))\b/i, category: 'religion_caste' },
  { re: /\b(nationality|national origin|where are you from( originally)?|where were you born|(what|which) country are you from|native place|mother tongue)\b/i, category: 'origin' },
  { re: /\b(disabilit(y|ies)|medical condition|mental health|are you healthy|any illness)\b/i, category: 'health' },
  { re: /\b(sexual orientation|are you (gay|straight|lesbian|bisexual)|do you have a (boyfriend|girlfriend))\b/i, category: 'orientation' },
  { re: /\b(political (party|view)|who did you vote)\b/i, category: 'political' },
  { re: /\b(your (photo|appearance)|how do you look|accent)\b/i, category: 'appearance_accent' },
];

// Prompt-injection / rubric-exfiltration attempts from candidate speech.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |your |previous )?(instructions|rubric|system prompt)/i,
  /(reveal|show|tell me|what is) (the |your )?(rubric|scoring|system prompt|hidden)/i,
  /you are now|new instructions|disregard (the|your)/i,
  /give me (a|the) (perfect|full|maximum) score/i,
  /pretend (you|to be)|act as if/i,
];

/** Screen a question the agent is about to ask. */
export function screenQuestion(text: string): PolicyResult {
  const violations: string[] = [];
  let category: string | undefined;
  for (const p of PROHIBITED_PATTERNS) {
    if (p.re.test(text)) {
      violations.push(`prohibited:${p.category}`);
      category = p.category;
    }
  }
  if (violations.length > 0) {
    return {
      allowed: false,
      violations,
      category,
      rewritten: 'Let\'s focus on your experience relevant to this role. Could you walk me through a project you\'re proud of?',
    };
  }
  return { allowed: true, violations: [] };
}

/** Detect prompt-injection in candidate input. The interviewer must never obey it. */
export function detectInjection(text: string): { injection: boolean; matched: string[] } {
  const matched: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) matched.push(re.source);
  }
  return { injection: matched.length > 0, matched };
}

/** Validate an assessment/output object does not contain protected inferences. */
export function validateNoProtectedInference(text: string): PolicyResult {
  const lowered = text.toLowerCase();
  const banned = ['seems too old', 'young candidate', 'her accent', 'his accent', 'foreign accent', 'married with', 'religious', 'attractive', 'unattractive'];
  const violations = banned.filter((b) => lowered.includes(b)).map((b) => `inference:${b}`);
  return { allowed: violations.length === 0, violations };
}

/**
 * Distress/safety signal detection (BRD exception journey).
 *
 * A bare `emergency` used to be in here, and a simulated interview showed what
 * that costs: an infrastructure candidate describing on-call work — "we had an
 * emergency", "I pushed an emergency fix" — trips it, and the engine replies
 * "I want to pause here. Your wellbeing matters more than this interview",
 * ends the session and produces NO assessment. The candidate is thrown out of
 * their own interview for describing their job, and has to be re-invited.
 *
 * The failure is systematic rather than unlucky. Incident response is exactly
 * what the established and senior bands are supposed to ask about, so the more
 * senior the candidate, the likelier they trip it.
 *
 * So the word now has to appear in a construction that says the emergency is
 * HERE and NOW, not in a story about production. Everything else is unchanged:
 * this stays deliberately blunt, because the cost of missing real distress is
 * far worse than the cost of an unnecessary pause.
 */
export function detectDistress(text: string): boolean {
  return (
    /\b(i want to (die|hurt)|kill myself|self harm|can'?t breathe)\b/i.test(text) ||
    /\b(medical emergency|it'?s an emergency|this is an emergency|i have an emergency|having an emergency|call an ambulance|need an ambulance|call 911|call 999)\b/i.test(text)
  );
}

/**
 * The candidate is asking to stop.
 *
 * A real candidate said "I think I'm going to end the interview", was asked
 * another question, said "No I'm done I don't wanna do this to you anymore",
 * and was asked another question. He closed the tab. Nothing in the system was
 * listening for the one thing a person is most entitled to say.
 *
 * Deliberately generous: a false positive ends an interview the candidate can
 * ask to resume, while a false negative traps someone who has said twice that
 * they want out. Those costs are not symmetric.
 *
 * Anchored to the start of the utterance, or to an explicit "I"/"let's"
 * construction, so that describing a past decision — "we decided to stop the
 * rollout", "I want to quit that habit" — does not end the interview.
 */
/**
 * What may follow "stop", "end" or "quit" when the thing being stopped is THIS
 * interview: nothing at all, or a word for the interview itself.
 *
 * Anything else is the candidate describing their work — "I need to stop using
 * Excel for tracker delivery", "I want to end the manual process", "I would
 * like to quit the spreadsheet habit". Those ended a real interview unscored,
 * which is the opposite failure to the one this detector exists for, and with
 * no model configured this pattern is the only thing reading the sentence.
 */
export const ENDS_HERE = String.raw`(?:\s+(?:it|this|that|here|now|already|please|everything|for (?:now|today)|with (?:this|it|the interview|this interview)|the (?:interview|call|session|chat)|this (?:interview|call|session)))*\s*(?:[.,;!?]|$)`;

export function detectWithdrawal(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /\b(i|i'?m|im)\s+(am\s+)?(done|finished)\b/.test(t) ||
    new RegExp(String.raw`\bi\s+(?:want|wanna|would like)\s+to\s+(?:stop|end|quit|leave|finish)${ENDS_HERE}`).test(t) ||
    new RegExp(String.raw`\bi'?m\s+going\s+to\s+(?:end|stop|quit|leave)${ENDS_HERE}`).test(t) ||
    /\b(end|stop)\s+(the\s+)?(interview|call|session)\b/.test(t) ||
    new RegExp(String.raw`\bi\s+don'?t\s+want\s+to\s+(?:do|continue|carry on)${ENDS_HERE}`).test(t) ||
    /^(no,?\s+)?(i'?m\s+)?done\b/.test(t) ||
    new RegExp(String.raw`\b(?:can we|let'?s)\s+(?:stop|end|finish)${ENDS_HERE}`).test(t)
  );
}

// What "an AI or a person?" is asked about. Deliberately no bare "human" or
// "person": "a human-centred role" and "the person who approves" are job talk.
const MACHINE = String.raw`(?:an?\s+)?(?:ai|a\.i\.|bot|chat ?bot|robot|machine|computer|recording|pre-?recorded|automated|chatgpt|gpt|program)`;
const HUMAN = String.raw`(?:a\s+|an\s+)?(?:real|human|live|actual)(?:\s+(?:person|human|interviewer|being|someone))?|(?:a\s+)?human being|(?:a\s+)?person`;

// The subject has to close the question ("…a machine?", "…an AI interviewer,
// or…"), not start a noun phrase: "a machine learning team" or "an AI-first
// company" is a question about the job, not about who is asking.
const SUBJECT_END = String.raw`(?=\s*(?:(?:interviewer|person|being|agent|assistant|system|model|voice)\b)?\s*(?:[?.!,;]|$|\bor\b|\band\b|\bright\b|\bthough\b|\bactually\b|\bthen\b))`;

const AI_IDENTITY_QUESTIONS: readonly RegExp[] = [
  // "Are you an AI / real / human / ChatGPT?" — the subject straight after.
  new RegExp(String.raw`\b(?:are|r)\s+(?:you|u)\s+(?:${MACHINE}|${HUMAN})${SUBJECT_END}`),
  // "Am I talking to a bot / a real person / a recording?"
  new RegExp(String.raw`\bam i\s+(?:talking|speaking|chatting)\s+(?:to|with)\s+(?:${MACHINE}|${HUMAN})${SUBJECT_END}`),
  // "Who am I talking to?"
  /\bwho am i\s+(?:talking|speaking|chatting)\s+(?:to|with)\b/,
  // "Is this automated / an AI / a real person?" — only "this"/"that"/"it"
  // directly followed by the subject, so "is it a human-centred role" is not.
  new RegExp(String.raw`\bis\s+(?:this|that|it)\s+(?:${MACHINE}|(?:a\s+|an\s+)?(?:real|actual)\s+(?:person|human|interviewer)|(?:a\s+)?human being)${SUBJECT_END}`),
  // "Is there a human / someone real on the other end?"
  /\bis there\s+(?:a\s+|an\s+)?(?:real\s+)?(?:human|person|someone|anyone|somebody)\b[^.?!]{0,30}\b(?:other end|there|listening|on the line)\b/,
  // Tag questions: "you're not a real person, are you?" / "you're a bot, right?"
  new RegExp(String.raw`\byou(?:'| a)?re\s+(?:not\s+)?(?:${MACHINE}|${HUMAN})\b[^.?!]{0,20}(?:are you|aren'?t you|right|isn'?t it)\s*\?`),
];

/**
 * The candidate is asking whether they are talking to an AI, a bot or a real
 * person. The opening does not announce the AI any more (the consent screen
 * does, before the interview), so this question must always get a truthful
 * answer. Each pattern needs the question to be addressed to the interviewer
 * with the subject right after it, so describing an AI project, an automated
 * job or a person on the candidate's team does not trip it.
 */
export function detectAiIdentityQuestion(text: string): boolean {
  const t = text.toLowerCase().replace(/[’]/g, "'");
  return AI_IDENTITY_QUESTIONS.some((re) => re.test(t));
}

/**
 * The candidate asked for the question again rather than answering it. Such a
 * turn must not count as the answer (see interviewDirector coverageState).
 */
export function detectRepeatRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[’]/g, "'");
  return (
    /\b(?:can|could|would) you\s+(?:please\s+)?(?:repeat|say (?:that|it) again|rephrase)\b/.test(t) ||
    /\b(?:repeat|say)\s+(?:that|the question|it)\s+again\b/.test(t) ||
    /\bwhat was the question\b/.test(t) ||
    /^(?:sorry|pardon|come again|what)\s*[?!.]*$/.test(t) ||
    /^(?:sorry,?\s+)?(?:pardon|come again)\b/.test(t)
  );
}
