/**
 * Near-duplicate detection for generated questions.
 *
 * L0 is lexical: normalised token shingles compared by Jaccard, capped to the
 * pool and its family, no native dependencies, so it runs on the VPS beside
 * live interviews without a model or an index. The `SimilarityBackend`
 * interface is the seam for an embedding backend later; the policy gate only
 * sees the verdict.
 */

export interface SimilarityBackend {
  readonly name: string;
  similarity(a: string, b: string): number | Promise<number>;
}

export interface DedupeThresholds {
  /** At or above: an owner should look (near-duplicate). */
  readonly near: number;
  /** At or above: rejected as a duplicate. */
  readonly duplicate: number;
}

export interface DedupeVerdict {
  readonly kind: 'none' | 'near' | 'duplicate';
  readonly score: number;
  readonly matchId?: string;
}

// Function words carry no meaning for "is this the same question"; dropping
// them stops two questions matching on "about a time you".
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'you', 'your', 'yours', 'me', 'my', 'i', 'we', 'our', 'it', 'its', 'this', 'that', 'these', 'those', 'about', 'when', 'where', 'how',
  'what', 'which', 'who', 'did', 'do', 'does', 'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will', 'there', 'their', 'them',
  'they', 'he', 'she', 'his', 'her', 'if', 'than', 'then', 'so', 'but', 'not', 'no', 'yes', 'up', 'out', 'into', 'over', 'any', 'some', 'one',
]);

export function normaliseTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

export function shingles(tokens: readonly string[], n = 3): Set<string> {
  if (tokens.length < n) return new Set(tokens);
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Token 2-shingles: short enough that a reworded clause still overlaps, long enough that topic words alone do not. */
export class LexicalShingleBackend implements SimilarityBackend {
  readonly name = 'lexical-shingle';
  constructor(private readonly n = 2) {}

  similarity(a: string, b: string): number {
    return jaccard(shingles(normaliseTokens(a), this.n), shingles(normaliseTokens(b), this.n));
  }
}

export function verdictFor(score: number, matchId: string | undefined, thresholds: DedupeThresholds): DedupeVerdict {
  if (score >= thresholds.duplicate) return { kind: 'duplicate', score, matchId };
  if (score >= thresholds.near) return { kind: 'near', score, matchId };
  return { kind: 'none', score, ...(matchId ? { matchId } : {}) };
}

/** The closest existing question to `text`, judged against the thresholds. */
export async function checkDuplicate(
  text: string,
  candidates: readonly { readonly id: string; readonly text: string }[],
  thresholds: DedupeThresholds,
  backend: SimilarityBackend,
): Promise<DedupeVerdict> {
  let best = 0;
  let bestId: string | undefined;
  for (const candidate of candidates) {
    const score = await backend.similarity(text, candidate.text);
    if (score > best) {
      best = score;
      bestId = candidate.id;
    }
  }
  return verdictFor(best, bestId, thresholds);
}

/** Indexes of texts that duplicate (at the near threshold) an earlier text in the same batch. */
export async function dedupeWithinBatch(texts: readonly string[], thresholds: DedupeThresholds, backend: SimilarityBackend): Promise<Set<number>> {
  const dropped = new Set<number>();
  for (let i = 0; i < texts.length; i++) {
    for (let j = 0; j < i; j++) {
      if (dropped.has(j)) continue;
      if ((await backend.similarity(texts[i], texts[j])) >= thresholds.near) {
        dropped.add(i);
        break;
      }
    }
  }
  return dropped;
}
