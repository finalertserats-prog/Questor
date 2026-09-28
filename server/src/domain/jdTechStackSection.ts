import { LEVEL_PHRASE, type TechStackItem } from './techStack.js';

/**
 * Keeping the job description's "Tech stack" section equal to the role's
 * tech stack, and touching nothing else in it.
 *
 * The section is found by its heading — "Tech stack", "Technical
 * requirements", "Technologies" and the spellings between, with or without
 * markdown marks or a colon — and extends over the bullet lines directly
 * under it, or over the heading line alone when the list is inline
 * ("Tech stack: React, Postgres."). Only those lines are replaced. A JD with
 * no such section gets one appended after its last line. Every other line,
 * and the file's line endings, come through byte for byte.
 */

export const TECH_SECTION_HEADING = 'Tech stack';

const HEADING = /^\s*(?:#{1,6}\s*|\*\*)?(?:tech(?:nical|nology)?\s+stack|technical\s+requirements|tech(?:nology)?\s+requirements|technologies(?:\s+(?:we|you)\s+(?:use|will\s+use|work\s+with))?)\s*(?:\*\*)?\s*(:?)\s*(.*?)\s*$/i;
const BULLET = /^\s*(?:[-*•–]|\d+[.)])\s+\S/;

export interface JdSection {
  /** Index of the heading line. */
  readonly start: number;
  /** Index after the last line of the section. */
  readonly end: number;
}

/** Where the tech-stack section sits in these lines, or null. */
export function findTechStackSection(lines: readonly string[]): JdSection | null {
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    const colon = m[1] === ':';
    const rest = m[2];
    // "Our tech stack is modern" is prose about the stack, not the section.
    if (rest && !colon) continue;
    // A heading with its list on the same line is the whole section.
    if (rest) return { start: i, end: i + 1 };
    // A bare heading with no bullet list under it is a sentence, not a section.
    if (!colon && !BULLET.test(lines[i + 1] ?? '')) continue;
    let end = i + 1;
    while (end < lines.length && BULLET.test(lines[end])) end++;
    return { start: i, end };
  }
  return null;
}

/** The candidate-facing lines: no rubric words, no level numbers. */
export function renderTechStackSection(stack: readonly TechStackItem[]): string[] {
  return [
    TECH_SECTION_HEADING,
    ...stack.map((t) => `- ${t.name}: ${LEVEL_PHRASE[t.level]} (${t.required ? 'required' : 'nice to have'})`),
  ];
}

export type JdSyncKind = 'unchanged' | 'inserted' | 'replaced' | 'removed';

export interface JdSyncResult {
  readonly text: string;
  readonly changed: boolean;
  readonly kind: JdSyncKind;
  /** The section's lines as they were, for a before/after confirmation. */
  readonly before: string[];
  /** The section's lines as they will be. */
  readonly after: string[];
}

/** Lines that read as the same section, whatever the surrounding whitespace. */
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, i) => line.trim() === b[i].trim());

export function syncJdTechStack(jd: string, stack: readonly TechStackItem[]): JdSyncResult {
  const eol = jd.includes('\r\n') ? '\r\n' : '\n';
  const lines = jd.split(/\r?\n/);
  const section = findTechStackSection(lines);
  const after = stack.length ? renderTechStackSection(stack) : [];
  const before = section ? lines.slice(section.start, section.end) : [];

  if (!section) {
    if (!stack.length) return { text: jd, changed: false, kind: 'unchanged', before, after };
    // Appended below the last non-blank line, one blank line apart.
    let last = lines.length;
    while (last > 0 && lines[last - 1].trim() === '') last--;
    const kept = lines.slice(0, last);
    return { text: [...kept, ...(kept.length ? [''] : []), ...after].join(eol), changed: true, kind: 'inserted', before, after };
  }
  if (same(before, after)) return { text: jd, changed: false, kind: 'unchanged', before, after };

  const head = lines.slice(0, section.start);
  let tail = lines.slice(section.end);
  // Removing the section takes its blank line with it, so two blank lines do not meet.
  if (!after.length && tail[0]?.trim() === '' && head[head.length - 1]?.trim() === '') tail = tail.slice(1);
  return {
    text: [...head, ...after, ...tail].join(eol),
    changed: true,
    kind: after.length ? 'replaced' : 'removed',
    before,
    after,
  };
}
