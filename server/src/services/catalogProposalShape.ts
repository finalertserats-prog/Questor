import { z } from 'zod';
import { logger } from '../logger.js';

/**
 * A proposal as the review page sees it. Source links come from outside
 * (O*NET, ESCO, a model's web search) and end up as hrefs in the owner's
 * browser, so anything that is not an http(s) URL is dropped here.
 */

export const PROPOSAL_INCLUDE = {
  domain: { select: { id: true, name: true } },
  family: { select: { id: true, name: true } },
  targetRole: { select: { id: true, title: true, status: true } },
} as const;

const sourceSchema = z.object({
  source: z.enum(['onet', 'esco', 'web']),
  ref: z.string().max(500),
  url: z.string().max(2000).optional(),
  label: z.string().max(300).optional(),
});

export type ProposalSource = z.infer<typeof sourceSchema>;

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch { return undefined; }
}

export function parseProposalSources(id: string, sourcesJson: string): ProposalSource[] {
  let raw: unknown;
  try { raw = JSON.parse(sourcesJson); } catch { raw = null; }
  if (!Array.isArray(raw)) {
    logger.warn({ proposalId: id }, 'Catalog proposal has unreadable sources');
    return [];
  }
  return raw.flatMap((entry) => {
    const parsed = sourceSchema.safeParse(entry);
    if (!parsed.success) return [];
    const { url, ...rest } = parsed.data;
    const safe = safeUrl(url);
    return [safe ? { ...rest, url: safe } : rest];
  });
}

/** The first source's name, which an approved alias records as its source. */
export function firstSourceName(id: string, sourcesJson: string): string {
  return parseProposalSources(id, sourcesJson)[0]?.source ?? 'automation';
}

export interface ProposalRow {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly status: string;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly sourcesJson: string;
  readonly reviewerNote: string;
  readonly reviewedAt: Date | null;
  readonly createdCatalogRoleId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly domain: { readonly id: string; readonly name: string } | null;
  readonly family: { readonly id: string; readonly name: string } | null;
  readonly targetRole: { readonly id: string; readonly title: string; readonly status: string } | null;
}

export function shapeProposal(row: ProposalRow) {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    status: row.status,
    title: row.title,
    summary: row.summary,
    confidence: row.confidence,
    domain: row.domain,
    family: row.family,
    targetRole: row.targetRole,
    sources: parseProposalSources(row.id, row.sourcesJson),
    reviewerNote: row.reviewerNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdCatalogRoleId: row.createdCatalogRoleId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ShapedProposal = ReturnType<typeof shapeProposal>;
