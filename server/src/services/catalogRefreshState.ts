import { z } from 'zod';

/**
 * What a catalog refresh run remembers between chunks: where each source got
 * to (the cursor) and what it found (the stats). Both are stored on the run
 * row after every chunk, so a restarted process resumes instead of starting
 * over. Pure; the database writes live in catalogRefreshRun.ts.
 */

export const SOURCE_KEYS = ['onet', 'esco', 'web'] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

const MAX_ERRORS_PER_SOURCE = 20;

const count = z.number().int().nonnegative().catch(0);

const sourceStatsSchema = z.object({
  fetched: count,
  matchedExisting: count,
  proposed: count,
  skipped: count,
  errors: z.array(z.string()).catch([]),
  skippedReason: z.string().optional().catch(undefined),
});

export type SourceStats = z.infer<typeof sourceStatsSchema>;
export type RefreshStats = Readonly<Record<SourceKey, SourceStats>>;

const EMPTY_SOURCE: SourceStats = { fetched: 0, matchedExisting: 0, proposed: 0, skipped: 0, errors: [] };
const statsSchema = z.object({
  onet: sourceStatsSchema.catch(EMPTY_SOURCE).default(EMPTY_SOURCE),
  esco: sourceStatsSchema.catch(EMPTY_SOURCE).default(EMPTY_SOURCE),
  web: sourceStatsSchema.catch(EMPTY_SOURCE).default(EMPTY_SOURCE),
});

const cursorSchema = z.object({
  onet: z.object({ offset: count, done: z.boolean().catch(false) }).catch({ offset: 0, done: false }).default({ offset: 0, done: false }),
  esco: z.object({ offset: count, pages: count, done: z.boolean().catch(false) }).catch({ offset: 0, pages: 0, done: false }).default({ offset: 0, pages: 0, done: false }),
  escoRoles: z.object({ offset: count, lookups: count, done: z.boolean().catch(false) }).catch({ offset: 0, lookups: 0, done: false }).default({ offset: 0, lookups: 0, done: false }),
  web: z.object({ domainIndex: count, calls: count, done: z.boolean().catch(false) }).catch({ domainIndex: 0, calls: 0, done: false }).default({ domainIndex: 0, calls: 0, done: false }),
});

export type RefreshCursor = z.infer<typeof cursorSchema>;

function parseStored(json: string): unknown {
  try { return JSON.parse(json); } catch { return {}; }
}

/** A corrupt cursor costs a re-read of the sources, which dedupe makes harmless. */
export function parseCursor(json: string): RefreshCursor {
  const parsed = cursorSchema.safeParse(parseStored(json));
  return parsed.success ? parsed.data : cursorSchema.parse({});
}

export function parseStats(json: string): RefreshStats {
  const parsed = statsSchema.safeParse(parseStored(json));
  return parsed.success ? parsed.data : emptyStats();
}

export function emptyStats(): RefreshStats {
  return { onet: EMPTY_SOURCE, esco: EMPTY_SOURCE, web: EMPTY_SOURCE };
}

/**
 * A new run pages on through ESCO from where the last run stopped, so the
 * whole classification is covered over successive months; everything else is
 * re-read from the start.
 */
export function nextRunCursor(previous: RefreshCursor | null): RefreshCursor {
  const fresh = cursorSchema.parse({});
  if (!previous) return fresh;
  return {
    ...fresh,
    esco: { offset: previous.esco.offset, pages: 0, done: false },
    escoRoles: { offset: previous.escoRoles.offset, lookups: 0, done: false },
  };
}

export type StatsDelta = Partial<Pick<SourceStats, 'fetched' | 'matchedExisting' | 'proposed' | 'skipped'>>;

export function bumpSourceStats(stats: RefreshStats, source: SourceKey, delta: StatsDelta): RefreshStats {
  const current = stats[source];
  return {
    ...stats,
    [source]: {
      ...current,
      fetched: current.fetched + (delta.fetched ?? 0),
      matchedExisting: current.matchedExisting + (delta.matchedExisting ?? 0),
      proposed: current.proposed + (delta.proposed ?? 0),
      skipped: current.skipped + (delta.skipped ?? 0),
    },
  };
}

export function addSourceError(stats: RefreshStats, source: SourceKey, message: string): RefreshStats {
  const errors = [...stats[source].errors, message.slice(0, 300)].slice(-MAX_ERRORS_PER_SOURCE);
  return { ...stats, [source]: { ...stats[source], errors } };
}

export function setSkippedReason(stats: RefreshStats, source: SourceKey, reason: string): RefreshStats {
  return { ...stats, [source]: { ...stats[source], skippedReason: reason } };
}
