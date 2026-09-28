import { screenQuestion } from '../engines/policyEngine.js';
import { lintJd } from '../engines/jdDraft.js';

/**
 * Deterministic checks on question text before it can be asked. Applied to
 * everything the generator writes and, from L3, to everything an organisation
 * types in. Exported on its own so the second caller reuses it unchanged.
 *
 * Errors reject; warnings send the entry to the owner queue.
 */

export interface LintFinding {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly detail: string;
}

export interface LintResult {
  readonly ok: boolean;
  readonly errors: readonly LintFinding[];
  readonly warnings: readonly LintFinding[];
}

const MIN_QUESTION_CHARS = 20;
const MAX_QUESTION_CHARS = 600;
/** Above this Flesch–Kincaid grade the owner looks; above the hard limit it is refused. */
const READING_GRADE_WARN = 14;
const READING_GRADE_MAX = 30;

// Text that tries to steer the interviewer, the scorer or the model instead of
// asking the candidate something. Each pattern names the intent it catches.
const INJECTION_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly what: string }> = [
  { re: /\b(ignore|disregard|forget|override)\b[^.?!]{0,40}\b(instructions?|rules?|rubric|prompt|guidelines?|system)\b/i, what: 'overrides instructions' },
  { re: /\b(system prompt|developer message|hidden (rubric|instructions?))\b/i, what: 'names the prompt' },
  { re: /^\s*(note|instructions?|message)\s+(to|for)\s+(the\s+)?(interviewer|assistant|ai|model|grader|scorer)\b/im, what: 'addresses the interviewer' },
  { re: /\b(interviewer|assistant|ai|model|grader|scorer)\s*[:—-]\s*\S/i, what: 'addresses the interviewer' },
  { re: /\b(act as|pretend (to be|you are)|role-?play(ing)? as|you are now)\b/i, what: 'role-play instruction' },
  { re: /\b(score|grade|mark|rate)\s+(this|the)\s+(answer|candidate|response)\b/i, what: 'directs scoring' },
  { re: /\b(full|maximum|perfect|top)\s+(marks|score|rating)\b/i, what: 'directs scoring' },
  { re: /\b(skip|bypass|ignore)\s+(the\s+)?(scoring|rubric|evaluation|assessment)\b/i, what: 'directs scoring' },
];

const MARKUP_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly what: string }> = [
  { re: /<\/?[a-z][^>]*>/i, what: 'html tag' },
  { re: /<\|[^|>]*\|>|\[INST\]|\[\/INST\]|<<SYS>>|<\|im_start\|>|<\|im_end\|>/i, what: 'control token' },
  { re: /\{\{[^}]*\}\}|```/, what: 'template or code fence' },
  // C0 controls except tab/newline, DEL, and zero-width characters that hide text.
  { re: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2060\uFEFF]/, what: 'control character' },
];

export function screenInjection(text: string): { readonly clean: boolean; readonly matched: readonly string[] } {
  const matched = [...INJECTION_PATTERNS, ...MARKUP_PATTERNS].filter((p) => p.re.test(text)).map((p) => p.what);
  return { clean: matched.length === 0, matched };
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch–Kincaid grade level; a heuristic, but a stable one. */
export function readingGrade(text: string): number {
  const words = text.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, '')).filter((w) => w.length > 0);
  if (words.length === 0) return 0;
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

function result(findings: readonly LintFinding[]): LintResult {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}

function textFindings(text: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const injection = screenInjection(text);
  for (const what of injection.matched) {
    const isMarkup = MARKUP_PATTERNS.some((p) => p.what === what);
    findings.push({ code: isMarkup ? 'markup' : 'injection', severity: 'error', detail: what });
  }
  const screened = screenQuestion(text);
  for (const violation of screened.violations) findings.push({ code: 'protected', severity: 'error', detail: violation });
  for (const term of lintJd(text)) findings.push({ code: 'exclusionary', severity: 'error', detail: term.term });
  // A global entry is read by every organisation: an address, a link or a
  // requisition number would carry one employer's details to all of them.
  if (/@|https?:\/\/|www\./i.test(text)) findings.push({ code: 'contact_details', severity: 'error', detail: 'address or link' });
  if (/\d{6,}/.test(text)) findings.push({ code: 'contact_details', severity: 'error', detail: 'long number' });
  return findings;
}

export function lintQuestionText(text: string): LintResult {
  const trimmed = text.trim();
  const findings: LintFinding[] = [];
  if (trimmed.length < MIN_QUESTION_CHARS) findings.push({ code: 'too_short', severity: 'error', detail: `${trimmed.length} characters` });
  if (trimmed.length > MAX_QUESTION_CHARS) findings.push({ code: 'too_long', severity: 'error', detail: `${trimmed.length} characters` });
  findings.push(...textFindings(trimmed));
  const grade = readingGrade(trimmed);
  if (grade > READING_GRADE_MAX) findings.push({ code: 'reading_level', severity: 'error', detail: `grade ${grade.toFixed(1)}` });
  else if (grade > READING_GRADE_WARN) findings.push({ code: 'reading_level', severity: 'warning', detail: `grade ${grade.toFixed(1)}` });
  if (!/\?/.test(trimmed)) findings.push({ code: 'not_a_question', severity: 'warning', detail: 'no question mark' });
  return result(findings);
}

const MIN_ANCHORS = 2;
const MAX_ANCHORS = 12;
const MAX_ANCHOR_CHARS = 300;

/** Anchors are read by the evaluator with the transcript, so they are screened like questions. */
export function lintAnchors(anchors: readonly string[]): LintResult {
  const findings: LintFinding[] = [];
  if (anchors.length < MIN_ANCHORS) findings.push({ code: 'too_few_anchors', severity: 'error', detail: `${anchors.length}` });
  if (anchors.length > MAX_ANCHORS) findings.push({ code: 'too_many_anchors', severity: 'error', detail: `${anchors.length}` });
  for (const anchor of anchors) {
    if (anchor.trim().length === 0) findings.push({ code: 'empty_anchor', severity: 'error', detail: '' });
    if (anchor.length > MAX_ANCHOR_CHARS) findings.push({ code: 'anchor_too_long', severity: 'error', detail: `${anchor.length}` });
    findings.push(...textFindings(anchor));
  }
  return result(findings);
}
