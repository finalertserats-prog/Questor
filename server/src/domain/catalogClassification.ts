import { z } from 'zod';
import { normalizeTitle } from './catalogText.js';
import type { CatalogRoleForMatch } from './catalogMatch.js';

/**
 * Deciding which domain (and job family) a proposed new role belongs to.
 * Pure: the model call lives in services/catalogClassify.ts; here are the
 * fallback and the check that keeps a model's invented id away from a foreign
 * key.
 */

export interface Classification {
  readonly domainId: string | null;
  readonly familyId: string | null;
  readonly confidence: number;
}

export interface AllowedClassificationIds {
  readonly domainIds: ReadonlySet<string>;
  /**
   * Families are one global list in the schema; a family "belongs" to a domain
   * when active roles of that domain use it. That is what keeps a nursing
   * family off a software role.
   */
  readonly familiesByDomain: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The fallback never claims to be more than a coin toss. */
export const OVERLAP_MAX_CONFIDENCE = 0.5;
const OVERLAP_BASE_CONFIDENCE = 0.25;

export function familiesByDomain(roles: readonly CatalogRoleForMatch[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const role of roles) {
    if (!role.familyId) continue;
    out.set(role.domainId, new Set([...(out.get(role.domainId) ?? []), role.familyId]));
  }
  return out;
}

function tokens(value: string): Set<string> {
  return new Set(normalizeTitle(value).split(' ').filter((token) => token.length > 1));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const shared = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

/** The domain and family of the existing role whose title shares the most words. */
export function tokenOverlapClassification(title: string, roles: readonly CatalogRoleForMatch[]): Classification {
  const titleTokens = tokens(title);
  let best: { readonly role: CatalogRoleForMatch; readonly score: number } | null = null;
  for (const role of roles) {
    const score = jaccard(titleTokens, tokens(role.title));
    if (score > 0 && (!best || score > best.score)) best = { role, score };
  }
  if (!best) return { domainId: null, familyId: null, confidence: 0 };
  const confidence = Math.min(OVERLAP_MAX_CONFIDENCE, OVERLAP_BASE_CONFIDENCE + best.score);
  return { domainId: best.role.domainId, familyId: best.role.familyId, confidence: Math.round(confidence * 100) / 100 };
}

const modelRowSchema = z.object({
  title: z.string().min(1).max(200),
  domainId: z.string().min(1).max(64).nullable(),
  familyId: z.string().min(1).max(64).nullable().optional(),
  confidence: z.number().min(0).max(1),
});

/**
 * Keep only rows whose ids are real: a domain id the model made up would fail
 * the proposal insert, and a family from another domain would mislabel the
 * role. A bad domain drops the row (the caller falls back); a bad family is
 * cleared, since the domain is still usable.
 */
export function validateModelClassifications(raw: unknown, allowed: AllowedClassificationIds): Map<string, Classification> {
  const out = new Map<string, Classification>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const parsed = modelRowSchema.safeParse(item);
    if (!parsed.success) continue;
    const { title, domainId, familyId, confidence } = parsed.data;
    if (!domainId || !allowed.domainIds.has(domainId)) continue;
    const family = familyId && allowed.familiesByDomain.get(domainId)?.has(familyId) ? familyId : null;
    out.set(normalizeTitle(title), { domainId, familyId: family, confidence });
  }
  return out;
}
