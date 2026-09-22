import type { PlanBlock } from '../domain/types.js';

/**
 * The approved questions the Q&A library stored on a plan block
 * (block.library.ladder, easiest to hardest), in the order the fallback
 * writers should reach for them.
 *
 * Read structurally, not through the library's types: a plan made with the
 * library off, or before it existed, has no ladder, and then this is empty and
 * every caller behaves exactly as it did before. Anchors are never read here,
 * so they cannot reach anything that is spoken.
 */

interface LadderShape {
  readonly source?: unknown;
  readonly startRung?: unknown;
  readonly ladder?: unknown;
}

function ladderTexts(block: PlanBlock | undefined): { texts: string[]; start: number } {
  const library = (block as { library?: LadderShape } | undefined)?.library;
  if (!library || library.source !== 'library' || !Array.isArray(library.ladder)) return { texts: [], start: 0 };
  const texts: string[] = [];
  for (const rung of library.ladder as unknown[]) {
    const text = (rung as { questionText?: unknown } | null)?.questionText;
    if (typeof text !== 'string' || !text.trim()) return { texts: [], start: 0 };
    texts.push(text.trim());
  }
  const middle = Math.floor((texts.length - 1) / 2);
  const start = typeof library.startRung === 'number' && Number.isInteger(library.startRung) && library.startRung >= 0 && library.startRung < texts.length
    ? library.startRung
    : middle;
  return { texts, start };
}

/** The ladder from the planned starting rung upwards, then the easier rungs below it. */
export function plannedLadder(block: PlanBlock | undefined): string[] {
  const { texts, start } = ladderTexts(block);
  return [...texts.slice(start), ...texts.slice(0, start).reverse()];
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The planned rungs this interview has not asked yet (a rung inside a longer turn counts as asked). */
export function unaskedRungs(block: PlanBlock | undefined, askedTexts: readonly string[]): string[] {
  const asked = askedTexts.map(normalise);
  return plannedLadder(block).filter((rung) => !asked.some((a) => a.includes(normalise(rung))));
}
