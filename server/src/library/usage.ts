import { prisma } from '../db.js';
import type { InterviewPlan, PlanBlock, TurnRecord } from '../domain/types.js';
import { detectCandidateIntent } from '../engines/candidateIntent.js';
import { isAnswerInContext } from '../engines/conversationModel.js';
import { answerQuality } from '../engines/interviewDirector.js';
import { withoutFillers } from '../engines/libraryTurn.js';
import { logger } from '../logger.js';
import { promoteIfEligible } from './lifecycle.js';
import { isCompetencyBlock } from './planLadders.js';
import { loadPolicy } from './policy.js';

/**
 * What an interview the library planned tells the library, written once the
 * interview is assessed: one LibraryUsage row per library rung asked, and one
 * per built-in block, so the interleaved trial can compare the two sides of
 * the same interview. Also the anchors the evaluator grades against, from the
 * plan's snapshot of the entries actually asked.
 *
 * Pure derivation first (rows from the plan and the transcript); the write is
 * idempotent on (session, blockKey), so finalising twice records once.
 */

export type RungMoveRecord = 'start' | 'up' | 'down' | '';

export interface UsageRow {
  readonly blockKey: string;
  readonly competencyId: string;
  readonly competencyKey: string;
  readonly entryId: string | null;
  readonly blockSource: 'library' | 'builtin';
  readonly trial: boolean;
  readonly outcome: 'answered' | 'non-answer' | 'skipped';
  readonly evidenceYield: number | null;
  readonly probeCount: number;
  readonly confusionMarkers: number;
  readonly rungIndex: number | null;
  readonly rungMove: RungMoveRecord;
}

const CONFUSION = /\b(?:not sure what you mean|what do you mean|don'?t (?:understand|follow) (?:the|your) question|could you (?:repeat|rephrase)|say that again)\b/i;

interface Segment {
  readonly entryId: string | null;
  readonly rungIndex: number | null;
  readonly turnIndexes: readonly number[];
}

/** The block's turns, split at each library rung asked (a block with none is one segment). */
function segmentsOf(block: PlanBlock, turns: readonly TurnRecord[]): Segment[] {
  const ladder = block.library?.ladder ?? [];
  const segments: Array<{ entryId: string | null; rungIndex: number | null; turnIndexes: number[] }> = [];
  turns.forEach((t, i) => {
    if (t.competencyId !== block.competencyId) return;
    const rungIndex = t.speaker === 'agent' && t.libraryEntryId ? ladder.findIndex((r) => r.entryId === t.libraryEntryId) : -1;
    const alreadyOpen = rungIndex >= 0 && segments.some((s) => s.rungIndex === rungIndex);
    if (rungIndex >= 0 && !alreadyOpen) segments.push({ entryId: ladder[rungIndex].entryId, rungIndex, turnIndexes: [i] });
    else if (segments.length === 0) segments.push({ entryId: null, rungIndex: null, turnIndexes: [i] });
    else segments[segments.length - 1].turnIndexes.push(i);
  });
  return segments;
}

function measure(turns: readonly TurnRecord[], indexes: readonly number[]) {
  const answers = indexes.filter((i) => isAnswerInContext(turns, i)).map((i) => turns[i].text);
  const candidateTurns = indexes.filter((i) => turns[i].speaker === 'candidate');
  const skipped = candidateTurns.some((i) => detectCandidateIntent(turns[i].text).intent === 'skip');
  const outcome: UsageRow['outcome'] = answers.length > 0 ? 'answered' : skipped ? 'skipped' : 'non-answer';
  const evidenceYield = answers.length > 0
    ? Math.round((answers.reduce((sum, a) => sum + answerQuality(withoutFillers(a)).score, 0) / answers.length)) / 100
    : candidateTurns.length > 0 ? 0 : null;
  const probeCount = indexes.filter((i) => turns[i].speaker === 'agent' && turns[i].kind === 'followup').length;
  const confusionMarkers = candidateTurns.filter((i) => detectCandidateIntent(turns[i].text).intent === 'repeat' || CONFUSION.test(turns[i].text)).length;
  return { outcome, evidenceYield, probeCount, confusionMarkers };
}

export function usageRowsFor(plan: InterviewPlan, turns: readonly TurnRecord[]): UsageRow[] {
  if (!plan.library) return [];
  const rows: UsageRow[] = [];
  for (const block of plan.blocks) {
    const lib = block.library;
    if (!lib || !isCompetencyBlock(block)) continue;
    const segments = segmentsOf(block, turns);
    if (segments.length === 0) continue; // never reached
    const rungs = segments.filter((s) => s.entryId !== null);
    if (lib.source === 'library' && rungs.length > 0) {
      // Turns before the first rung (a pause, a re-ask) belong to the first rung's question.
      let previous: number | null = null;
      for (const seg of rungs) {
        const indexes = seg === rungs[0] ? segments.filter((s) => s.entryId === null).flatMap((s) => s.turnIndexes).concat(seg.turnIndexes) : seg.turnIndexes;
        const move: RungMoveRecord = previous === null ? 'start' : (seg.rungIndex ?? 0) > previous ? 'up' : 'down';
        previous = seg.rungIndex;
        rows.push({
          blockKey: `${block.competencyId}#${seg.entryId}`, competencyId: block.competencyId, competencyKey: lib.competencyKey,
          entryId: seg.entryId, blockSource: 'library', trial: lib.trial, rungIndex: seg.rungIndex, rungMove: move,
          ...measure(turns, [...indexes].sort((a, b) => a - b)),
        });
      }
      continue;
    }
    // A built-in block — or a library block whose rungs could not be asked
    // (no model), which ran on the built-in bank and is no side of the pair.
    const drewOnLibrary = lib.source === 'library';
    rows.push({
      blockKey: `${block.competencyId}#builtin`, competencyId: block.competencyId, competencyKey: lib.competencyKey,
      entryId: null, blockSource: 'builtin', trial: lib.trial && !drewOnLibrary, rungIndex: null, rungMove: '',
      ...measure(turns, segments.flatMap((s) => s.turnIndexes)),
    });
  }
  return rows;
}

/** Per competency: the anchors of the library entries this interview actually asked, from the plan's snapshot. */
export function anchorsFor(plan: InterviewPlan, turns: readonly TurnRecord[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!plan.library) return out;
  for (const block of plan.blocks) {
    const ladder = block.library?.source === 'library' ? block.library.ladder ?? [] : [];
    if (ladder.length === 0) continue;
    const asked = new Set(turns.filter((t) => t.speaker === 'agent' && t.competencyId === block.competencyId && t.libraryEntryId).map((t) => t.libraryEntryId));
    const anchors = [...new Set(ladder.filter((r) => asked.has(r.entryId)).flatMap((r) => r.anchors))];
    if (anchors.length) out[block.competencyId] = anchors;
  }
  return out;
}

function isDuplicate(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * Write the interview's usage rows. Each row is its own insert, so a second
 * finalisation (or two at once) meets the unique (session, blockKey) and skips
 * what is already there instead of counting an interview twice. Probational
 * entries asked are then considered for promotion. Returns the rows written.
 */
export async function recordLibraryUsage(input: {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly roleId: string;
  readonly plan: InterviewPlan;
  readonly turns: readonly TurnRecord[];
  readonly now?: Date;
}): Promise<number> {
  const rows = usageRowsFor(input.plan, input.turns);
  if (rows.length === 0) return 0;
  const askedAt = input.now ?? new Date();
  let written = 0;
  for (const row of rows) {
    try {
      await prisma.libraryUsage.create({
        data: {
          ...row, interviewSessionId: input.sessionId, tenantId: input.tenantId, roleId: input.roleId,
          roleSlug: input.plan.library?.roleSlug ?? '', askedAt,
        },
      });
      written += 1;
    } catch (err) {
      if (!isDuplicate(err)) throw err;
    }
  }
  const asked = [...new Set(rows.flatMap((r) => (r.entryId ? [r.entryId] : [])))];
  if (written > 0 && asked.length > 0) {
    const policy = await loadPolicy();
    for (const entryId of asked) {
      await promoteIfEligible(entryId, policy).catch((err: unknown) => {
        logger.warn({ entryId, err: err instanceof Error ? err.message : String(err) }, 'Library promotion check failed');
      });
    }
  }
  return written;
}
