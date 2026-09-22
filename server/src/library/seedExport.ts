import { z } from 'zod';
import { prisma } from '../db.js';
import { slugifyCatalogName } from '../domain/catalogText.js';
import { BANDS } from '../engines/experienceBands.js';
import { platformCompetencyCatalog, type PlatformCompetency } from '../engines/roleIntelligence.js';
import { loadDemandQueue } from './demand.js';
import { SEED_SOURCE } from './seedFormat.js';

/**
 * The pools an offline seed run should fill, as a file the laptop generator
 * reads (scripts/library-seed). It is the worker's own demand queue — global
 * pools below target — filtered so that only global-catalog text leaves the
 * server (owner decision 2026-09-22):
 *
 *   - the catalog role's title, family and shared JD draft or summary, never
 *     an organisation's own job description;
 *   - only pools whose competency is one of the platform's own
 *     (platformCompetencyCatalog), worded as the platform words it, never
 *     with the organisation's scorecard definition or indicators; a pool for
 *     an organisation's own competency stays on the server for the worker;
 *   - the live family standard and the pool's questions only when the seed
 *     run itself wrote them (from text exported here). The server worker
 *     writes from the organisation's own scorecard wording, so its questions
 *     and standards stay on the server; only their forms are counted.
 *
 * Run it where the demand lives (production, read-only), copy the file to the
 * laptop, generate, copy the JSONL back, import (seedImport.ts).
 */

export const SEED_POOLS_FORMAT = 'questor-library-seed-pools/1';
const MAX_EXISTING = 60;

const BAND_IDS = BANDS.map((b) => b.id) as [string, ...string[]];

export const seedPoolSchema = z.object({
  key: z.string(),
  roleSlug: z.string().min(1),
  roleTitle: z.string().min(1),
  familySlug: z.string().min(1),
  familyName: z.string().min(1),
  competencyKey: z.string().min(1),
  competency: z.object({ name: z.string(), definition: z.string(), indicators: z.array(z.string()), category: z.string() }),
  band: z.enum(BAND_IDS),
  jdText: z.string(),
  target: z.number().int().min(0),
  filled: z.number().int().min(0),
  formCounts: z.record(z.number().int().min(0)),
  existingQuestions: z.array(z.string()),
  standard: z.object({ anchors: z.array(z.string()), weakSigns: z.array(z.string()) }).nullable(),
});
export type SeedPool = z.infer<typeof seedPoolSchema>;

export const seedPoolsFileSchema = z.object({
  format: z.literal(SEED_POOLS_FORMAT),
  exportedAt: z.string(),
  pools: z.array(seedPoolSchema),
  /** Demand pools left on the server because their competency is an organisation's own. */
  skippedOrgCompetencyPools: z.number().int().min(0).default(0),
});
export type SeedPoolsFile = z.infer<typeof seedPoolsFileSchema>;

export interface ExportOptions {
  /** Catalog role slugs to keep; all when omitted. */
  readonly roles?: readonly string[];
  readonly bands?: readonly string[];
  readonly limit?: number;
  readonly now?: Date;
}

/**
 * The pool's global questions (never an organisation's private ones) and the
 * forms they take, drafts waiting for the owner included, so a second run
 * asks for the forms the pool lacks instead of repeating the first batch.
 */
async function globalPoolContent(pool: { readonly roleSlug: string; readonly competencyKey: string; readonly band: string }): Promise<{ readonly texts: string[]; readonly formCounts: Record<string, number> }> {
  const rows = await prisma.libraryEntry.findMany({
    where: { scope: 'global', tenantId: null, roleSlug: pool.roleSlug, competencyKey: pool.competencyKey, band: pool.band, status: { notIn: ['rejected', 'retired'] } },
    orderBy: { createdAt: 'desc' },
    select: { questionText: true, form: true, createdBy: true },
  });
  const formCounts: Record<string, number> = {};
  for (const row of rows) formCounts[row.form] = (formCounts[row.form] ?? 0) + 1;
  const seeded = rows.filter((r) => r.createdBy === SEED_SOURCE);
  return { texts: seeded.slice(0, MAX_EXISTING).map((r) => r.questionText), formCounts };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

async function liveStandardFor(pool: { readonly familySlug: string; readonly competencyKey: string; readonly band: string }): Promise<SeedPool['standard']> {
  const row = await prisma.libraryStandard.findFirst({ where: { familySlug: pool.familySlug, competencyKey: pool.competencyKey, band: pool.band, status: 'live' }, orderBy: { version: 'desc' } });
  if (!row || !row.generatorModel.startsWith(`${SEED_SOURCE}:`)) return null;
  try {
    const parsed: unknown = JSON.parse(row.anchorsJson);
    if (Array.isArray(parsed)) return { anchors: strings(parsed), weakSigns: [] };
    const obj = parsed as { anchors?: unknown; weakSigns?: unknown };
    return { anchors: strings(obj?.anchors), weakSigns: strings(obj?.weakSigns) };
  } catch {
    return null;
  }
}

export async function exportSeedPools(opts: ExportOptions = {}): Promise<SeedPoolsFile> {
  const now = opts.now ?? new Date();
  const roles = opts.roles && opts.roles.length > 0 ? new Set(opts.roles) : null;
  const bands = opts.bands && opts.bands.length > 0 ? new Set(opts.bands) : null;
  const platform = new Map<string, PlatformCompetency>(platformCompetencyCatalog().map((c) => [slugifyCatalogName(c.name), c]));
  const wanted = (await loadDemandQueue(now))
    .filter((p) => p.scope === 'global' && (!roles || roles.has(p.roleSlug)) && (!bands || bands.has(p.band)));
  const queue = wanted.filter((p) => platform.has(p.competencyKey)).slice(0, opts.limit ?? Number.MAX_SAFE_INTEGER);
  const pools: SeedPool[] = [];
  for (const p of queue) {
    const competency = platform.get(p.competencyKey) as PlatformCompetency;
    const [content, standard] = await Promise.all([globalPoolContent(p), liveStandardFor(p)]);
    pools.push({
      key: `${p.roleSlug}|${p.competencyKey}|${p.band}`,
      roleSlug: p.roleSlug, roleTitle: p.roleTitle, familySlug: p.familySlug, familyName: p.familyName,
      competencyKey: p.competencyKey, competency: { name: competency.name, definition: competency.definition, indicators: [...competency.indicators], category: competency.category }, band: p.band,
      jdText: p.jdText, target: p.target, filled: p.filled, formCounts: content.formCounts,
      existingQuestions: content.texts, standard,
    });
  }
  return { format: SEED_POOLS_FORMAT, exportedAt: now.toISOString(), pools, skippedOrgCompetencyPools: wanted.filter((p) => !platform.has(p.competencyKey)).length };
}
