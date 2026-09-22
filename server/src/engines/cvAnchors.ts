import type { CvAnchor, NormalizedProfile, PlanBlock, TurnRecord } from '../domain/types.js';

// Identity assurance L3: CV-anchored follow-ups. One or two questions quoting a
// specific line from the candidate's own CV. The person who did that work can
// talk about it at once, from memory; a stand-in answering for them has to
// improvise someone else's history. The questions are ordinary interview
// questions to the candidate: nothing in them suggests they are a check, and
// nothing about the answers is judged automatically. A person reads them.
//
// Built from the parsed CV already on the candidate's profile
// (engines/resumeParser.ts normalizeProfile). Bullets are the most reliable
// part of that parse: titles and company names are often split oddly, so the
// question quotes the line itself rather than naming an employer.

export const MAX_CV_ANCHORS = 2;
/** Long enough for one real accomplishment, short enough to read aloud. */
const MAX_FACT_CHARS = 160;
const MIN_FACT_CHARS = 20;

const ACTION_START = /^(led|built|designed|owned|created|launched|migrated|implemented|reduced|increased|improved|delivered|managed|ran|wrote|shipped|introduced|automated|optimi[sz]ed|negotiated|trained|established|developed|scaled)\b/i;

/** How much a CV line gives someone who was there to talk about. */
function specificity(line: string): number {
  let score = 0;
  if (/\d/.test(line)) score += 2;
  if (ACTION_START.test(line)) score += 1;
  if (line.length >= 40) score += 1;
  return score;
}

function clean(line: string): string {
  const text = line.replace(/\s+/g, ' ').trim().replace(/^[-•*]\s*/, '');
  if (text.length <= MAX_FACT_CHARS) return text;
  const cut = text.slice(0, MAX_FACT_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MIN_FACT_CHARS)).trim()}…`;
}

function mostSpecific(lines: readonly string[]): string | null {
  const usable = lines.map(clean).filter((l) => l.length >= MIN_FACT_CHARS);
  if (usable.length === 0) return null;
  return usable.reduce((best, l) => (specificity(l) > specificity(best) ? l : best));
}

const FIRST_QUESTION = (fact: string) =>
  `I'd like to hear more about something on your CV. You wrote: "${fact}" Can you walk me through it: what was the situation, and what did you personally do?`;
const SECOND_QUESTION = (fact: string) =>
  `One more from your CV: "${fact}" What is a detail of that work that has stayed with you, such as a problem you ran into or a decision you had to make?`;

/**
 * Up to two CV lines worth asking about: the most specific line of the most
 * recent job, then one from earlier work (or a project), so the two questions
 * cover different parts of the candidate's history.
 */
export function cvAnchorsFrom(profile: Partial<NormalizedProfile> | undefined): CvAnchor[] {
  const facts: Array<{ source: CvAnchor['source']; fact: string }> = [];
  const jobs = profile?.employment ?? [];
  for (const job of jobs) {
    if (facts.length >= MAX_CV_ANCHORS) break;
    const fact = mostSpecific(job.bullets ?? []);
    if (fact) facts.push({ source: 'employment', fact });
  }
  for (const project of profile?.projects ?? []) {
    if (facts.length >= MAX_CV_ANCHORS) break;
    const fact = mostSpecific([project.summary ?? '']);
    if (fact) facts.push({ source: 'project', fact });
  }
  // A single long job: a second, different line from it is still first-hand.
  if (facts.length === 1 && jobs.length === 1) {
    const rest = (jobs[0].bullets ?? []).filter((b) => clean(b) !== facts[0].fact);
    const fact = mostSpecific(rest);
    if (fact) facts.push({ source: 'employment', fact });
  }
  return facts.map((f, i) => ({ ...f, question: i === 0 ? FIRST_QUESTION(f.fact) : SECOND_QUESTION(f.fact) }));
}

/**
 * The next CV question this block has not asked yet, or null when all have
 * been. Asked is judged from the transcript, so a rejoin or a retried turn
 * never repeats one.
 */
export function anchoredCvQuestion(block: PlanBlock | undefined, turns: readonly TurnRecord[]): string | null {
  const anchors = block?.cvAnchors ?? [];
  if (anchors.length === 0) return null;
  const asked = turns.filter((t) => t.speaker === 'agent' && t.competencyId === block?.competencyId).map((t) => t.text);
  return anchors.find((a) => !asked.some((text) => text.includes(a.question)))?.question ?? null;
}
