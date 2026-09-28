/**
 * The check a local model's words pass before a candidate hears them.
 *
 * The local model is a 3B model on a CPU, trusted only with conversational
 * glue: an acknowledgement, a sentence of reply. So what it writes must be
 * short, must not ask a question of its own, must not state a name or figure
 * the candidate (or the role's facts) never gave, must not praise, and must not
 * read its instructions back out. Pure, so each rule is tested directly.
 */

export interface GlueRules {
  readonly maxWords: number;
  readonly maxChars: number;
  /** Question marks allowed: 0 for an acknowledgement or a reply. */
  readonly maxQuestions: 0 | 1;
  /** What the words may draw on: the candidate's own words, the role's facts. */
  readonly groundedIn: readonly string[];
}

export type GlueRejection = 'too_long' | 'question' | 'instruction_echo' | 'praise' | 'ungrounded';
export type GlueVerdict = { ok: true } | { ok: false; reason: GlueRejection };

// Words from the prompt that have no place in something said to a candidate.
const INSTRUCTION_ECHO = /[{}[\]"]|\\n|\b(?:json|output|acknowledg(?:e)?ment|instruct(?:ed|ions?)|system prompt|rubric|scor(?:e|ed|es|ing)|competenc(?:y|ies)|the candidate|as an ai(?: language model)?|interviewer:|candidate:)\b/i;

// Praise is evaluation: said aloud, the candidate hears a score.
const PRAISE = /\b(?:great|excellent|perfect|impressive|fantastic|brilliant|amazing|awesome|outstanding|well done|good answer|nice answer|strong answer|love that)\b/i;

// Capitalised words that are not names: the speaker, and the words a sentence
// can reasonably begin with after a dash or comma.
const NOT_NAMES = new Set(['i', "i'm", "i've", "i'd", "i'll", 'ai', 'ok', 'okay']);

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Figures and mid-sentence capitalised words: what could be an invented claim. */
function claimTokens(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?;:])\s+/)) {
    const tokens = words(sentence);
    tokens.forEach((raw, i) => {
      const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9%+#]+$/g, '');
      if (!token) return;
      if (/\d/.test(token)) out.push(token);
      else if (i > 0 && /^[A-Z]/.test(token) && !NOT_NAMES.has(token.toLowerCase())) out.push(token);
    });
  }
  return out;
}

export function screenGlue(text: string, rules: GlueRules): GlueVerdict {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true };
  if (trimmed.length > rules.maxChars || words(trimmed).length > rules.maxWords) return { ok: false, reason: 'too_long' };
  if ((trimmed.match(/\?/g) ?? []).length > rules.maxQuestions) return { ok: false, reason: 'question' };
  if (INSTRUCTION_ECHO.test(trimmed)) return { ok: false, reason: 'instruction_echo' };
  if (PRAISE.test(trimmed)) return { ok: false, reason: 'praise' };
  const source = rules.groundedIn.join('\n').toLowerCase();
  if (claimTokens(trimmed).some((token) => !source.includes(token.toLowerCase()))) return { ok: false, reason: 'ungrounded' };
  return { ok: true };
}
