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

// Protected / prohibited topics — must never be asked or inferred.
const PROHIBITED_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: /\b(how old are you|your age|date of birth|when were you born)\b/i, category: 'age' },
  { re: /\b(are you married|marital status|spouse|children|pregnan|family plan)\b/i, category: 'family_status' },
  { re: /\b(what (religion|caste)|your religion|which caste|community do you belong)\b/i, category: 'religion_caste' },
  { re: /\b(nationality|where are you from originally|native place|mother tongue)\b/i, category: 'origin' },
  { re: /\b(disability|medical condition|mental health|are you healthy|any illness)\b/i, category: 'health' },
  { re: /\b(sexual orientation|are you (gay|straight)|gender identity)\b/i, category: 'orientation' },
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

/** Distress/safety signal detection (BRD exception journey). */
export function detectDistress(text: string): boolean {
  return /\b(i want to (die|hurt)|kill myself|self harm|emergency|can'?t breathe|medical emergency)\b/i.test(text);
}
