import { prisma, parseJsonOptional } from '../db.js';
import type { InterviewPlan } from '../domain/types.js';
import { CALLBACK_BLOCK_ID } from './planLadders.js';

/**
 * "Questions asked" on the assessment page: what the interviewer actually put
 * to the candidate in each block, and where it came from — a library entry
 * (in the interviewer's own words), the built-in bank, or the callback turn.
 * Shown for interviews the library planned; HR sees the questions, never the
 * anchors, which stay with the evaluator.
 */

export type QuestionSource = 'library' | 'builtin' | 'callback';

export interface AskedQuestion {
  readonly competencyId: string;
  readonly competencyName: string;
  readonly source: QuestionSource;
  readonly question: string;
  /** For a library question: how the interviewer reached this rung (start | up | down). */
  readonly rungMove?: string;
}

export interface StoredTurn {
  readonly speaker: string;
  readonly text: string;
  readonly competencyId: string;
  readonly metaJson: string;
}

/** Agent turns that put a question, as opposed to pausing, re-asking or answering the candidate. */
const ASKING_KINDS = new Set(['question', 'followup', 'transition', 'work_sample', 'clarify']);

function metaOf(json: string): { kind?: string; question?: string; libraryEntryId?: string; rungMove?: string } {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    return {
      ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
      ...(typeof raw.question === 'string' ? { question: raw.question } : {}),
      ...(typeof raw.libraryEntryId === 'string' ? { libraryEntryId: raw.libraryEntryId } : {}),
      ...(typeof raw.rungMove === 'string' ? { rungMove: raw.rungMove } : {}),
    };
  } catch {
    return {};
  }
}

export function questionsAsked(plan: InterviewPlan, turns: readonly StoredTurn[]): AskedQuestion[] {
  const names = new Map(plan.blocks.map((b) => [b.competencyId, b.competencyName]));
  const out: AskedQuestion[] = [];
  for (const turn of turns) {
    if (turn.speaker !== 'agent') continue;
    const isCallback = turn.competencyId === CALLBACK_BLOCK_ID;
    if (turn.competencyId.startsWith('__') && !isCallback) continue;
    const meta = metaOf(turn.metaJson);
    if (!ASKING_KINDS.has(meta.kind ?? 'question')) continue;
    const source: QuestionSource = isCallback ? 'callback' : meta.libraryEntryId ? 'library' : 'builtin';
    out.push({
      competencyId: turn.competencyId,
      competencyName: names.get(turn.competencyId) ?? turn.competencyId,
      source,
      question: (meta.question ?? turn.text).slice(0, 600),
      ...(source === 'library' && meta.rungMove ? { rungMove: meta.rungMove } : {}),
    });
  }
  return out;
}

/** The list for one interview, or null when the library did not plan it (the page then shows nothing new). */
export async function questionsAskedFor(sessionId: string): Promise<AskedQuestion[] | null> {
  const plan = await prisma.interviewPlanVersion.findUnique({ where: { sessionId }, select: { id: true, planJson: true } });
  if (!plan) return null;
  const parsed = parseJsonOptional<Partial<InterviewPlan>>(plan.planJson, {}, { model: 'InterviewPlanVersion', id: plan.id, field: 'planJson' });
  if (!parsed.library || !Array.isArray(parsed.blocks)) return null;
  const turns = await prisma.turn.findMany({ where: { sessionId }, orderBy: { index: 'asc' }, select: { speaker: true, text: true, competencyId: true, metaJson: true } });
  return questionsAsked(parsed as InterviewPlan, turns);
}
