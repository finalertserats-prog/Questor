import type { LibraryProbeSnapshot, LibraryQuestionSnapshot, PlanBlock, TurnRecord } from '../domain/types.js';
import { answerQuality } from './interviewDirector.js';
import { answerSince, withoutFillers } from './libraryTurn.js';
import { detectInjection } from './policyEngine.js';

/**
 * What the fallback writers may offer as a follow-up on a block the Q&A
 * library planned: the suggested probes of the rung the interviewer is on.
 *
 * Read from the plan's snapshot (block.library.ladder[i].probes, see
 * domain/types.ts) and the turn metadata the runtime stores on a library turn
 * (libraryEntryId, rungIndex). Which rung to ask next is not decided here:
 * that is engines/libraryTurn.ts chooseRung, for every writer. A plan made
 * with the library off has no ladder, and then this is empty and every caller
 * behaves exactly as before. Anchors are never read here, so they cannot reach
 * anything that is spoken.
 */

export interface CurrentRung {
  readonly rung: LibraryQuestionSnapshot;
  readonly index: number;
  /** Transcript index of the turn that asked it. */
  readonly turnIndex: number;
}

/**
 * The rung this block last drew on: the newest agent turn in the block that
 * carries a library entry, located by its stored rungIndex (checked against
 * the entry, so a stale index cannot point at another question).
 */
export function currentRung(block: PlanBlock | undefined, turns: readonly TurnRecord[]): CurrentRung | null {
  const ladder = block?.library?.source === 'library' ? block.library.ladder ?? [] : [];
  if (!block || ladder.length === 0) return null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.speaker !== 'agent' || t.competencyId !== block.competencyId || !t.libraryEntryId) continue;
    const index = t.rungIndex !== undefined && ladder[t.rungIndex]?.entryId === t.libraryEntryId
      ? t.rungIndex
      : ladder.findIndex((r) => r.entryId === t.libraryEntryId);
    if (index >= 0) return { rung: ladder[index], index, turnIndex: i };
  }
  return null;
}

/** Whether a probe's `when` flags all match the engine's reading of the answer. No flags: always apt. */
export function probeApplies(probe: LibraryProbeSnapshot, answer: string): boolean {
  const quality = answerQuality(withoutFillers(answer));
  return Object.entries(probe.when ?? {}).every(([flag, wanted]) => wanted === undefined || quality[flag as keyof typeof quality] === wanted);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The current rung's probes that fit what the candidate has said since it was
 * asked, not already asked. Empty until L2 fills probes, and for any block the
 * library did not plan.
 */
export function plannedProbes(block: PlanBlock | undefined, turns: readonly TurnRecord[], askedTexts: readonly string[]): string[] {
  const current = currentRung(block, turns);
  if (!current) return [];
  const answer = answerSince(turns, current.turnIndex);
  if (!answer) return [];
  const asked = askedTexts.map(normalise);
  return (current.rung.probes ?? [])
    .filter((p) => typeof p.text === 'string' && p.text.trim() !== '')
    // Screened at creation; screened again here, since a probe can be spoken.
    .filter((p) => !detectInjection(p.text).injection && probeApplies(p, answer))
    .map((p) => p.text.trim())
    .filter((text) => !asked.some((a) => a.includes(normalise(text))));
}
