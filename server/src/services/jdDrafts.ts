
import { Prisma } from '@prisma/client';
import { prisma, parseJsonStrict } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { BANDS, type BandId } from '../engines/experienceBands.js';
import { draftJdFromDescriptionHeuristic, draftJdFromDescriptionWithLlm, draftJdHeuristic, draftJdWithLlm, lintJd, PROMPT_VERSION } from '../engines/jdDraft.js';
import type { AuthClaims } from './auth.js';
import { consume } from '../middleware/rateLimit.js';

const BAND_IDS = new Set<string>(BANDS.map((b) => b.id));
const FAILED_COOLDOWN_MS = 5 * 60_000;
/** Longer than any single generation takes, so a live claim is never stolen. */
const STALE_CLAIM_MS = 2 * 60_000;

type DraftRow = Awaited<ReturnType<typeof getOrQueueDraft>>;

export function isBandId(value: string): value is BandId {
  return BAND_IDS.has(value);
}

export async function getOrQueueDraft(input: { readonly catalogRoleId: string; readonly experienceBand: string; readonly regionCode: string }) {
  await validateInputs(input);
  const existing = await prisma.catalogJdDraft.findUnique({ where: { catalogRoleId_experienceBand_regionCode: input } });
  if (existing) {
    if (existing.status === 'failed' && Date.now() - existing.updatedAt.getTime() > FAILED_COOLDOWN_MS) {
      // A fresh set of attempts: the generator only picks up rows under the limit,
      // so a requeued row that kept attempts = 3 would wait forever.
      return prisma.catalogJdDraft.update({ where: { id: existing.id }, data: { status: 'pending', attempts: 0, lastError: '' } });
    }
    return existing;
  }
  try {
    return await prisma.catalogJdDraft.create({ data: input });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return prisma.catalogJdDraft.findUniqueOrThrow({ where: { catalogRoleId_experienceBand_regionCode: input } });
    }
    throw err;
  }
}

export async function generatePendingDrafts(opts: { readonly limit: number }): Promise<number> {
  // A row claimed as 'generating' by a process that stopped part-way would
  // otherwise stay claimed for ever; hand it back once the claim is stale.
  await prisma.catalogJdDraft.updateMany({
    where: { status: 'generating', updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
    data: { status: 'pending' },
  });
  const pending = await prisma.catalogJdDraft.findMany({
    where: { status: 'pending', attempts: { lt: 3 } },
    orderBy: { updatedAt: 'asc' },
    take: Math.max(1, opts.limit),
  });
  let generated = 0;
  for (const row of pending) {
    const claimed = await prisma.catalogJdDraft.updateMany({ where: { id: row.id, status: 'pending', updatedAt: row.updatedAt }, data: { status: 'generating' } });
    if (claimed.count !== 1) continue;
    try {
      await generateOne(row.id);
      generated += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      await prisma.catalogJdDraft.update({
        where: { id: row.id },
        data: { status: attempts >= 3 ? 'failed' : 'pending', attempts, lastError: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500) },
      });
    }
  }
  return generated;
}

async function generateOne(id: string): Promise<void> {
  const row = await prisma.catalogJdDraft.findUniqueOrThrow({
    where: { id },
    include: { catalogRole: { include: { domain: true, family: true } }, region: true },
  });
  const band = assertBand(row.experienceBand);
  const input = {
    title: row.catalogRole.title,
    domainName: row.catalogRole.domain.name,
    familyName: row.catalogRole.family?.name ?? '',
    summary: row.catalogRole.summary,
    marketSignal: row.catalogRole.marketSignal,
    band,
    regionName: row.region.name,
  };
  const llm = await draftJdWithLlm(input);
  const heuristicText = draftJdHeuristic(input);
  const chosen = chooseDraft(llm, heuristicText);
  await prisma.catalogJdDraft.update({
    where: { id },
    data: {
      status: 'ready',
      text: chosen.text,
      generator: chosen.generator,
      model: chosen.model,
      promptVersion: chosen.promptVersion,
      lintJson: JSON.stringify(chosen.lint),
      lastError: '',
    },
  });
}

export async function draftFromDescription(input: {
  readonly auth: AuthClaims;
  readonly description: string;
  readonly title?: string;
  readonly band: string;
  readonly regionCode: string;
  readonly domainId?: string;
}) {
  const max = input.auth.demo ? 5 : 20;
  const verdict = await consume('jd-draft-describe', input.auth.userId, 15 * 60_000, max);
  if (!verdict.allowed) throw new HttpError(429, 'Too many requests. Please wait a moment and try again.');
  const band = assertBand(input.band);
  const region = await prisma.catalogRegion.findFirst({ where: { code: input.regionCode, status: 'active' }, select: { name: true } });
  if (!region) throw new HttpError(400, 'Unknown or inactive catalog region.');
  const domain = input.domainId ? await prisma.catalogDomain.findFirst({ where: { id: input.domainId, status: 'active' }, select: { name: true } }) : null;
  if (input.domainId && !domain) throw new HttpError(400, 'Unknown or inactive catalog domain.');
  const heuristicText = draftJdFromDescriptionHeuristic({ title: input.title, description: input.description, band, regionName: region.name, domainName: domain?.name });
  // The model writes from the description when one is configured (never in a
  // demo); the built-in writer is the fallback, and the fairer text wins.
  const llm = await draftJdFromDescriptionWithLlm({ title: input.title, description: input.description, band, regionName: region.name, domainName: domain?.name });
  const chosen = chooseDraft(llm, heuristicText);
  return { text: chosen.text, lint: chosen.lint, generator: chosen.generator };
}

export function shapeDraft(row: DraftRow) {
  return { status: row.status, text: row.text, lint: parseJsonStrict<Array<{ term: string; suggestion: string }>>(row.lintJson, { model: 'CatalogJdDraft', id: row.id, field: 'lintJson' }), generator: row.generator, id: row.id };
}

function chooseDraft(llm: Awaited<ReturnType<typeof draftJdWithLlm>>, heuristicText: string) {
  const heuristicLint = lintJd(heuristicText);
  if (!llm) return { text: heuristicText, generator: 'heuristic' as const, model: '', promptVersion: PROMPT_VERSION, lint: heuristicLint };
  const llmLint = lintJd(llm.text);
  if (llmLint.length > heuristicLint.length) return { text: heuristicText, generator: 'heuristic' as const, model: '', promptVersion: PROMPT_VERSION, lint: heuristicLint };
  return { text: llm.text, generator: 'llm' as const, model: llm.model, promptVersion: PROMPT_VERSION, lint: llmLint };
}

async function validateInputs(input: { readonly catalogRoleId: string; readonly experienceBand: string; readonly regionCode: string }): Promise<void> {
  assertBand(input.experienceBand);
  const [role, region] = await Promise.all([
    prisma.catalogRole.findFirst({ where: { id: input.catalogRoleId, status: 'active' }, select: { id: true } }),
    prisma.catalogRegion.findFirst({ where: { code: input.regionCode, status: 'active' }, select: { code: true } }),
  ]);
  if (!role) throw new HttpError(400, 'Unknown or inactive catalog role.');
  if (!region) throw new HttpError(400, 'Unknown or inactive catalog region.');
}

function assertBand(value: string): BandId {
  if (isBandId(value)) return value;
  throw new HttpError(400, 'Unknown experience band.');
}
