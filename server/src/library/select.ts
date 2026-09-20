import { prisma } from '../db.js';
import { parseEntryBody, questionFormSchema, type EntrySnapshot } from './types.js';

/**
 * A ladder per competency: two or three live entries spanning difficulty,
 * least recently asked first (with a small shuffle among the top five so two
 * interviews scheduled the same minute do not get the same ladder), no entry
 * or supersession ancestor asked for this role in this organisation inside
 * the no-repeat window, and no form used twice in one ladder. Thin pool →
 * empty ladder, never an error: the planner falls back to the built-in bank.
 */

export interface SelectableEntry {
  readonly id: string;
  readonly difficultyTag: number;
  readonly form: string;
  readonly lastAskedAt: Date | null;
  /** This entry and every entry it supersedes. */
  readonly chainIds: readonly string[];
}

export interface LadderOptions {
  readonly recentlyUsedIds: ReadonlySet<string>;
  readonly rng: () => number;
  readonly size?: number;
}

export const LADDER_SIZE = 3;
export const MIN_LADDER = 2;
const SHUFFLE_TOP = 5;

function shuffleHead<T>(items: readonly T[], count: number, rng: () => number): T[] {
  const head = items.slice(0, count);
  for (let i = head.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [head[i], head[j]] = [head[j], head[i]];
  }
  return [...head, ...items.slice(count)];
}

/**
 * Never-asked entries first (shuffled among the top five, so two interviews
 * planned the same minute differ), then asked entries strictly least-recent
 * first. An asked entry never jumps ahead of one that has not been asked.
 */
function lruOrder(entries: readonly SelectableEntry[], rng: () => number): SelectableEntry[] {
  const never = [...entries].filter((e) => e.lastAskedAt === null).sort((a, b) => (a.id < b.id ? -1 : 1));
  const asked = [...entries].filter((e): e is SelectableEntry & { lastAskedAt: Date } => e.lastAskedAt !== null)
    .sort((a, b) => a.lastAskedAt.getTime() - b.lastAskedAt.getTime());
  return [...shuffleHead(never, SHUFFLE_TOP, rng), ...asked];
}

export function buildLadder(entries: readonly SelectableEntry[], opts: LadderOptions): SelectableEntry[] {
  const size = opts.size ?? LADDER_SIZE;
  const usable = entries.filter((e) => !e.chainIds.some((id) => opts.recentlyUsedIds.has(id)));
  if (usable.length < MIN_LADDER) return [];
  const ordered = lruOrder(usable, opts.rng);
  const chosen: SelectableEntry[] = [];
  const usedForms = new Set<string>();
  const take = (predicate: (e: SelectableEntry) => boolean) => {
    const pick = ordered.find((e) => !chosen.includes(e) && !usedForms.has(e.form) && predicate(e));
    if (pick) {
      chosen.push(pick);
      usedForms.add(pick.form);
    }
  };
  // One rung per difficulty first, then fill the gaps: a difficulty the ladder
  // lacks before one it has, always with a form it has not used (no form may
  // pass half of it). A ladder on one difficulty is no ladder: the director
  // steps up and down it, so it must span at least two.
  for (const difficulty of [1, 2, 3].slice(0, size)) take((e) => e.difficultyTag === difficulty);
  while (chosen.length < size) {
    const before = chosen.length;
    const have = new Set(chosen.map((e) => e.difficultyTag));
    take((e) => !have.has(e.difficultyTag));
    if (chosen.length === before) take(() => true);
    if (chosen.length === before) break;
  }
  if (chosen.length < MIN_LADDER || new Set(chosen.map((e) => e.difficultyTag)).size < 2) return [];
  return chosen.sort((a, b) => a.difficultyTag - b.difficultyTag);
}

// --- Database-backed selection ---------------------------------------------

export interface SelectRequest {
  readonly tenantId: string;
  readonly roleSlug: string;
  readonly band: string;
  readonly competencyKeys: readonly string[];
  readonly includeProbational: boolean;
  readonly windowDays: number;
  readonly now?: Date;
  readonly rng?: () => number;
}

export type Ladders = Readonly<Record<string, readonly EntrySnapshot[]>>;

interface EntryRow {
  readonly id: string;
  readonly competencyKey: string;
  readonly form: string;
  readonly difficultyTag: number;
  readonly questionText: string;
  readonly bodyJson: string;
  readonly standardId: string | null;
  readonly supersedesId: string | null;
}

/** Ids this entry supersedes, following the chain through the rows loaded (chains are short). */
function chainOf(entry: EntryRow, byId: ReadonlyMap<string, EntryRow>): string[] {
  const chain = [entry.id];
  let cursor = entry.supersedesId;
  while (cursor && !chain.includes(cursor)) {
    chain.push(cursor);
    cursor = byId.get(cursor)?.supersedesId ?? null;
  }
  return chain;
}

export function snapshotOf(entry: EntryRow): EntrySnapshot {
  const form = questionFormSchema.safeParse(entry.form);
  return {
    entryId: entry.id,
    standardId: entry.standardId,
    questionText: entry.questionText,
    anchors: parseEntryBody(entry.bodyJson).anchors,
    form: form.success ? form.data : 'other',
    difficultyTag: entry.difficultyTag,
  };
}

export async function selectLadders(req: SelectRequest): Promise<Ladders> {
  const now = req.now ?? new Date();
  const rng = req.rng ?? Math.random;
  const statuses = req.includeProbational ? ['live', 'probational'] : ['live'];
  const entries: EntryRow[] = await prisma.libraryEntry.findMany({
    where: {
      roleSlug: req.roleSlug, band: req.band, competencyKey: { in: [...req.competencyKeys] }, status: { in: statuses },
      OR: [{ scope: 'global' }, { scope: 'org', tenantId: req.tenantId }],
    },
    select: { id: true, competencyKey: true, form: true, difficultyTag: true, questionText: true, bodyJson: true, standardId: true, supersedesId: true },
  });
  if (entries.length === 0) return Object.fromEntries(req.competencyKeys.map((key) => [key, []]));
  // Ancestors may be retired, so they are loaded separately, generation by
  // generation, until the chain ends: a grandparent asked last week must block
  // its twice-edited descendant as surely as a parent would.
  const ancestors: EntryRow[] = [];
  const seen = new Set(entries.map((e) => e.id));
  let wanted = entries.map((e) => e.supersedesId).filter((id): id is string => id !== null && !seen.has(id));
  while (wanted.length > 0) {
    for (const id of wanted) seen.add(id);
    const rows: EntryRow[] = await prisma.libraryEntry.findMany({
      where: { id: { in: wanted } },
      select: { id: true, competencyKey: true, form: true, difficultyTag: true, questionText: true, bodyJson: true, standardId: true, supersedesId: true },
    });
    ancestors.push(...rows);
    wanted = rows.map((r) => r.supersedesId).filter((id): id is string => id !== null && !seen.has(id));
  }
  const byId = new Map([...entries, ...ancestors].map((e) => [e.id, e]));
  const since = new Date(now.getTime() - req.windowDays * 24 * 60 * 60_000);
  const recent = await prisma.libraryUsage.findMany({
    where: { tenantId: req.tenantId, roleSlug: req.roleSlug, askedAt: { gte: since } },
    select: { entryId: true },
  });
  const recentlyUsedIds = new Set(recent.map((u) => u.entryId));
  // Least-recently-asked is judged over all time, not only the window.
  const history = await prisma.libraryUsage.groupBy({ by: ['entryId'], where: { tenantId: req.tenantId, roleSlug: req.roleSlug }, _max: { askedAt: true } });
  const lastAsked = new Map(history.map((h) => [h.entryId, h._max.askedAt]));
  const ladders: Record<string, readonly EntrySnapshot[]> = {};
  for (const key of req.competencyKeys) {
    const pool = entries.filter((e) => e.competencyKey === key).map((e) => ({
      id: e.id, difficultyTag: e.difficultyTag, form: e.form, lastAskedAt: lastAsked.get(e.id) ?? null, chainIds: chainOf(e, byId),
    }));
    const ladder = buildLadder(pool, { recentlyUsedIds, rng });
    ladders[key] = ladder.map((rung) => snapshotOf(byId.get(rung.id) as EntryRow));
  }
  return ladders;
}
