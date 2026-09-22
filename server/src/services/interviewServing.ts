import { prisma } from '../db.js';
import type { ServedCall } from '../providers/llm/servingTrace.js';

/**
 * Degraded mode, recorded per interviewer turn and read back for the
 * assessment page. When the primary model was unavailable, a turn was written
 * by the local fallback model or the built-in writer; reviewers are told which,
 * so a thinner probe is not held against the candidate.
 */

type Layer = ServedCall['layer'];

export interface TurnServing {
  readonly layer: Layer;
  /** True when an outage, not an ordinary screened-out reply, put the turn below the primary. */
  readonly degraded: boolean;
  readonly failure?: string;
}

export interface ServingMode {
  readonly degraded: boolean;
  /** The degraded turns, by transcript index. */
  readonly turns: ReadonlyArray<{ readonly index: number; readonly layer: Layer; readonly failure?: string }>;
  readonly counts: { readonly primary: number; readonly local: number; readonly builtIn: number };
}

const RANK: Record<Layer, number> = { primary: 0, local: 1, 'built-in': 2 };

/** What to add to an agent turn's metadata, from the calls made while composing it. */
export function servingMeta(served: readonly ServedCall[]): { serving?: TurnServing } {
  if (served.length === 0) return {};
  const lowest = served.reduce((a, b) => (RANK[b.layer] > RANK[a.layer] ? b : a));
  const degraded = served.some((c) => c.layer === 'local' || (c.layer === 'built-in' && c.failure !== undefined));
  return { serving: { layer: lowest.layer, degraded, ...(lowest.failure ? { failure: lowest.failure } : {}) } };
}

function readServing(metaJson: string): TurnServing | null {
  try {
    const serving = (JSON.parse(metaJson) as { serving?: unknown }).serving;
    if (!serving || typeof serving !== 'object') return null;
    const { layer, degraded, failure } = serving as Record<string, unknown>;
    if (layer !== 'primary' && layer !== 'local' && layer !== 'built-in') return null;
    return { layer, degraded: degraded === true, ...(typeof failure === 'string' ? { failure } : {}) };
  } catch {
    return null;
  }
}

export function summariseServing(rows: ReadonlyArray<{ index: number; speaker: string; metaJson: string }>): ServingMode {
  const recorded = rows
    .filter((r) => r.speaker === 'agent')
    .map((r) => ({ index: r.index, serving: readServing(r.metaJson) }))
    .filter((r): r is { index: number; serving: TurnServing } => r.serving !== null);
  const turns = recorded
    .filter((r) => r.serving.degraded)
    .map((r) => ({ index: r.index, layer: r.serving.layer, ...(r.serving.failure ? { failure: r.serving.failure } : {}) }));
  const countOf = (layer: Layer) => recorded.filter((r) => r.serving.layer === layer).length;
  return { degraded: turns.length > 0, turns, counts: { primary: countOf('primary'), local: countOf('local'), builtIn: countOf('built-in') } };
}

export async function servingModeForSession(sessionId: string): Promise<ServingMode> {
  const rows = await prisma.turn.findMany({
    where: { sessionId, speaker: 'agent' }, orderBy: { index: 'asc' }, select: { index: true, speaker: true, metaJson: true },
  });
  return summariseServing(rows);
}
