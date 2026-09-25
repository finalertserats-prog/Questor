import type { DirectorSignal, LibraryQuestionSnapshot, PlanBlock, TurnRecord } from '../domain/types.js';
import { isAnswerInContext } from './conversationModel.js';
import { answerQuality } from './interviewDirector.js';
import { detectInjection } from './policyEngine.js';

/**
 * How the interviewer draws on a library ladder. Pure: the conversation
 * runtime asks which rung to draw on next, and the model phrases it.
 *
 * The library is a source, never a script. A rung is a question the
 * interviewer may ask about, in its own words and tied to what the candidate
 * just said (conversationRuntime); it is never read out as written.
 *
 * Moving between rungs follows the engine's own answerQuality() reading of
 * the answer: a strong answer earns the harder rung, a thin one the easier
 * rung (or, with none left, the existing probe). The reading is taken on the
 * content of the whole answer — every part of it since the rung was asked,
 * with filler words removed — never on its pace, its pauses, or the order the
 * candidate told it in: a candidate who pauses, speaks slowly or starts from
 * the result is read on what they said.
 */

export type RungMove = 'start' | 'up' | 'down';

export interface RungChoice {
  readonly rung: LibraryQuestionSnapshot;
  readonly index: number;
  readonly move: RungMove;
}

export type RungSignal = 'strong' | 'thin' | 'hold';

// Hesitation words carry no content; left in, they would only pad the count.
const FILLERS = /\b(?:u+m+|u+h+|e+r+m*|hmm+|mm+|you know|i mean|sort of|kind of)\b[,.]?/gi;

export function withoutFillers(text: string): string {
  return text.replace(FILLERS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The reading a rung move follows: content only. Strong is a whole account —
 * a situation, the candidate's own action and a result; thin is neither an
 * action nor a result. Length, pace and order play no part, and answerQuality's
 * score (which leans on word count) is deliberately not used.
 */
export function rungSignal(answer: string): RungSignal {
  const q = answerQuality(withoutFillers(answer));
  if (q.hasSituation && q.hasAction && q.hasResult) return 'strong';
  if (!q.hasAction && !q.hasResult) return 'thin';
  return 'hold';
}

function isLibraryBlock(block: PlanBlock | undefined): block is PlanBlock & { library: { ladder: readonly LibraryQuestionSnapshot[] } } {
  return block?.library?.source === 'library' && (block.library.ladder?.length ?? 0) >= 2;
}

/** Rungs of this block already drawn on, in the order they were asked: [ladder index, transcript index]. */
export function askedRungs(block: PlanBlock, turns: readonly TurnRecord[]): Array<{ readonly index: number; readonly turnIndex: number }> {
  const ladder = block.library?.ladder ?? [];
  const out: Array<{ index: number; turnIndex: number }> = [];
  turns.forEach((t, turnIndex) => {
    if (t.speaker !== 'agent' || t.competencyId !== block.competencyId || !t.libraryEntryId) return;
    const index = ladder.findIndex((r) => r.entryId === t.libraryEntryId);
    if (index >= 0 && !out.some((a) => a.index === index)) out.push({ index, turnIndex });
  });
  return out;
}

/** Everything the candidate has answered since the given transcript index, as one text. */
export function answerSince(turns: readonly TurnRecord[], fromTurnIndex: number): string {
  const parts: string[] = [];
  for (let i = fromTurnIndex + 1; i < turns.length; i++) {
    if (isAnswerInContext(turns, i)) parts.push(turns[i].text);
  }
  return parts.join(' ');
}

/** The start rung, or the nearest one whose form the no-repeat window allows. */
function startingRung(ladder: readonly LibraryQuestionSnapshot[], start: number, blockedForms: readonly string[]): number {
  const order = [start, ...ladder.flatMap((_, d) => (d === 0 ? [] : [start - d, start + d]))].filter((i) => i >= 0 && i < ladder.length);
  return order.find((i) => !blockedForms.includes(ladder[i].form)) ?? start;
}

/**
 * Which rung to draw on next, or null to leave the turn to the built-in path
 * (the block is not a library block, or the move the answer calls for has no
 * rung left — then the existing probe ladder follows up, as it always has).
 */
export function chooseRung(block: PlanBlock | undefined, turns: readonly TurnRecord[], action: DirectorSignal['action'], blockedForms: readonly string[]): RungChoice | null {
  if (!isLibraryBlock(block)) return null;
  const ladder = block.library.ladder;
  const asked = askedRungs(block, turns);
  if (asked.length === 0) {
    if (action === 'followup') return null;
    const start = Math.max(0, Math.min(ladder.length - 1, block.library.startRung ?? Math.floor((ladder.length - 1) / 2)));
    const index = startingRung(ladder, start, blockedForms);
    return { rung: ladder[index], index, move: 'start' };
  }
  if (action !== 'followup') return null;
  const last = asked[asked.length - 1];
  const used = new Set(asked.map((a) => a.index));
  const signal = rungSignal(answerSince(turns, last.turnIndex));
  if (signal === 'strong') {
    const up = ladder.findIndex((_, i) => i > last.index && !used.has(i));
    return up >= 0 ? { rung: ladder[up], index: up, move: 'up' } : null;
  }
  if (signal === 'thin') {
    let down = -1;
    for (let i = last.index - 1; i >= 0; i--) if (!used.has(i)) { down = i; break; }
    return down >= 0 ? { rung: ladder[down], index: down, move: 'down' } : null;
  }
  return null;
}

// --- Keeping the source a source -------------------------------------------

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []);
}

/** The same words in the same order, give or take case and punctuation: read out, not rephrased. */
export function isVerbatim(spoken: string, source: string): boolean {
  const said = words(spoken).join(' ');
  const written = words(source).join(' ');
  return written.length > 0 && said.includes(written);
}

const STOP = new Set(['about', 'after', 'again', 'also', 'because', 'been', 'being', 'could', 'does', 'from', 'have', 'into', 'just', 'like', 'made', 'more', 'most', 'much', 'only', 'other', 'over', 'same', 'some', 'such', 'tell', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'time', 'very', 'walk', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your']);

function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 6)));
}

/** Share of the source's content words the spoken question kept: whether it asked about the same thing. */
export function sourceOverlap(spoken: string, source: string): number {
  const from = contentWords(source);
  if (from.size === 0) return 0;
  const said = contentWords(spoken);
  let kept = 0;
  for (const w of from) if (said.has(w)) kept += 1;
  return kept / from.size;
}

/** Below this the model asked about something else; the turn is not the library's. */
export const MIN_SOURCE_OVERLAP = 0.15;

// --- The callback turn -------------------------------------------------------

export interface CallbackSource {
  readonly competencyId: string;
  readonly snippet: string;
}

/** Competency blocks the candidate has answered at least once, in order. */
export function answeredCompetencies(turns: readonly TurnRecord[]): string[] {
  const ids: string[] = [];
  turns.forEach((t, i) => {
    if (t.competencyId && !t.competencyId.startsWith('__') && !ids.includes(t.competencyId) && isAnswerInContext(turns, i)) ids.push(t.competencyId);
  });
  return ids;
}

/**
 * Something the candidate said in an earlier competency answer that the
 * callback can refer back to: the first clause of their fullest answer, in
 * their own words. Never text that tries to instruct the interviewer — the
 * candidate's words are data, and a callback must not read an injection back.
 */
export function callbackSource(turns: readonly TurnRecord[]): CallbackSource | null {
  let best: { turn: TurnRecord; score: number } | null = null;
  turns.forEach((t, i) => {
    if (!t.competencyId || t.competencyId.startsWith('__') || !isAnswerInContext(turns, i)) return;
    if (detectInjection(t.text).injection) return;
    const score = answerQuality(withoutFillers(t.text)).score;
    if (!best || score > best.score) best = { turn: t, score };
  });
  if (!best) return null;
  const chosen = (best as { turn: TurnRecord }).turn;
  const clause = withoutFillers(chosen.text).split(/(?<=[.!?;])\s+|,\s+(?:and|but|so)\s+/)[0] ?? '';
  const snippet = clause.split(/\s+/).slice(0, 14).join(' ').replace(/[.!?;,]+$/, '');
  return snippet.split(/\s+/).length >= 4 ? { competencyId: chosen.competencyId as string, snippet } : null;
}
