/**
 * "Questions asked" on the assessment page, for interviews the question
 * library planned (GET /api/assessments/:id `questionsAsked`). Pure, so the
 * grouping and wording are tested (web/tests/questionsAskedModel.test.ts).
 */

export type QuestionSource = 'library' | 'builtin' | 'callback';

export interface AskedQuestion {
  readonly competencyId: string;
  readonly competencyName: string;
  readonly source: QuestionSource;
  readonly question: string;
  readonly rungMove?: string;
}

export interface AskedGroup {
  readonly competencyId: string;
  readonly competencyName: string;
  readonly questions: readonly AskedQuestion[];
}

/** Said in brackets beside the question, never as a coloured block. */
export function sourceLabel(q: AskedQuestion): string {
  if (q.source === 'callback') return 'callback to an earlier answer';
  if (q.source === 'builtin') return 'built-in question';
  if (q.rungMove === 'up') return 'question library, harder step';
  if (q.rungMove === 'down') return 'question library, easier step';
  return 'question library';
}

/** In the order asked, one group per competency (a competency asked twice apart stays one group). */
export function groupQuestions(questions: readonly AskedQuestion[]): AskedGroup[] {
  const groups: Array<{ competencyId: string; competencyName: string; questions: AskedQuestion[] }> = [];
  for (const q of questions) {
    const group = groups.find((g) => g.competencyId === q.competencyId);
    if (group) group.questions.push(q);
    else groups.push({ competencyId: q.competencyId, competencyName: q.competencyName, questions: [q] });
  }
  return groups;
}

/** How many of the questions drew on the library, for the card's one-line summary. */
export function librarySummary(questions: readonly AskedQuestion[]): string {
  const fromLibrary = questions.filter((q) => q.source === 'library').length;
  if (questions.length === 0) return 'No questions were recorded for this interview.';
  return `${questions.length} question${questions.length === 1 ? '' : 's'} asked; ${fromLibrary} drew on the question library, in the interviewer's own words.`;
}
