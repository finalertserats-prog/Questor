
import { Prisma } from '@prisma/client';
import { prisma, parseJsonStrict } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { BANDS, type BandId } from '../engines/experienceBands.js';
import { draftJdFromDescriptionHeuristic, draftJdFromDescriptionWithLlm, draftJdHeuristic, draftJdWithLlm, globalLint, isGlobalRegion, lintJd, locationSpecificClaims, PROMPT_VERSION } from '../engines/jdDraft.js';
import type { AuthClaims } from './auth.js';
import { consume } from '../middleware/rateLimit.js';

const BAND_IDS = new Set<string>(BANDS.map((b) => b.id));
const FAILED_COOLDOWN_MS = 5 * 60_000;
/** Longer than any single generation takes, so a live claim is never stolen. */
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * The one background worker that writes shared drafts. The request path only
 * queues and nudges this job; it never generates itself, so a burst of
 * requests cannot fan out into parallel model calls.
 */
export const JD_DRAFT_JOB = { name: 'jd-draft-generate', ttlMs: 5 * 60_000, batch: 3 } as const;

/** New shared drafts one person / one organisation may queue. Reading existing drafts is not counted. */
const QUEUE_LIMIT_PER_USER = { windowMs: 15 * 60_000, max: 30 } as const;
const QUEUE_LIMIT_PER_TENANT = { windowMs: 24 * 60 * 60_000, max: 300 } as const;

type DraftRow = Awaited<ReturnType<typeof getOrQueueDraft>>;

export function isBandId(value: string): value is BandId {
  return BAND_IDS.has(value);
}

export async function getOrQueueDraft(
  input: { readonly catalogRoleId: string; readonly experienceBand: string; readonly regionCode: string },
  auth?: AuthClaims,
) {
  await validateInputs(input);
  const existing = await prisma.catalogJdDraft.findUnique({ where: { catalogRoleId_experienceBand_regionCode: input } });
  if (existing) {
    if (existing.status === 'failed' && Date.now() - existing.updatedAt.getTime() > FAILED_COOLDOWN_MS) {
      // A fresh set of attempts: the generator only picks up rows under the limit,
      // so a requeued row that kept attempts = 3 would wait forever.
      if (auth) await assertQueueQuota(auth);
      return prisma.catalogJdDraft.update({ where: { id: existing.id }, data: { status: 'pending', attempts: 0, lastError: '' } });
    }
    return existing;
  }
  if (auth) await assertQueueQuota(auth);
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
    const claimAt = new Date();
    const claimed = await prisma.catalogJdDraft.updateMany({ where: { id: row.id, status: 'pending', updatedAt: row.updatedAt }, data: { status: 'generating', updatedAt: claimAt } });
    if (claimed.count !== 1) continue;
    try {
      if (await generateOne(row.id, claimAt)) generated += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      await prisma.catalogJdDraft.updateMany({
        where: { id: row.id, status: 'generating', updatedAt: claimAt },
        data: { status: attempts >= 3 ? 'failed' : 'pending', attempts, lastError: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500) },
      });
    }
  }
  return generated;
}

async function generateOne(id: string, claimAt: Date): Promise<boolean> {
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
    regionCode: row.region.code,
  };
  const llm = await draftJdWithLlm(input);
  const heuristicText = draftJdHeuristic(input);
  const chosen = chooseDraft(llm, heuristicText, isGlobalRegion(row.region.code));
  return finishDraft(id, claimAt, {
    status: 'ready',
    text: chosen.text,
    generator: chosen.generator,
    model: chosen.model,
    promptVersion: chosen.promptVersion,
    lintJson: JSON.stringify(chosen.lint),
    lastError: '',
  });
}

/**
 * Write a finished draft only if this worker still holds the claim it took.
 * A claim reclaimed as stale (and possibly re-generated by another worker)
 * has a different stamp, so a slow first worker cannot overwrite the result.
 */
export async function finishDraft(
  id: string,
  claimAt: Date,
  data: { status: string; text: string; generator: string; model: string; promptVersion: string; lintJson: string; lastError: string },
): Promise<boolean> {
  const written = await prisma.catalogJdDraft.updateMany({ where: { id, status: 'generating', updatedAt: claimAt }, data });
  return written.count === 1;
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
  const region = await prisma.catalogRegion.findFirst({ where: { code: input.regionCode, status: 'active' }, select: { name: true, code: true } });
  if (!region) throw new HttpError(400, 'Unknown or inactive catalog region.');
  const domain = input.domainId ? await prisma.catalogDomain.findFirst({ where: { id: input.domainId, status: 'active' }, select: { name: true } }) : null;
  if (input.domainId && !domain) throw new HttpError(400, 'Unknown or inactive catalog domain.');
  const described = { title: input.title, description: input.description, band, regionName: region.name, regionCode: region.code, domainName: domain?.name };
  const heuristicText = draftJdFromDescriptionHeuristic(described);
  // The model writes from the description when one is configured (never in a
  // demo); the built-in writer is the fallback, and the fairer text wins.
  const llm = await draftJdFromDescriptionWithLlm(described);
  const chosen = chooseDraft(llm, heuristicText, isGlobalRegion(region.code));
  return { text: chosen.text, lint: chosen.lint, generator: chosen.generator };
}

export function shapeDraft(row: DraftRow) {
  return { status: row.status, text: row.text, lint: parseJsonStrict<Array<{ term: string; suggestion: string }>>(row.lintJson, { model: 'CatalogJdDraft', id: row.id, field: 'lintJson' }), generator: row.generator, id: row.id };
}

/**
 * The model's draft unless the built-in one is fairer. For a Global role the
 * model's draft must also make no place-specific claim, and any such claim
 * left in the chosen text (repeated from the team's own description) is shown
 * as a lint hit so the team can reword it.
 */
function chooseDraft(llm: Awaited<ReturnType<typeof draftJdWithLlm>>, heuristicText: string, global: boolean) {
  const lintFor = (text: string) => (global ? [...lintJd(text), ...globalLint(text)] : lintJd(text));
  const heuristic = { text: heuristicText, generator: 'heuristic' as const, model: '', promptVersion: PROMPT_VERSION, lint: lintFor(heuristicText) };
  if (!llm || (global && locationSpecificClaims(llm.text).length > 0)) return heuristic;
  const llmLint = lintFor(llm.text);
  if (llmLint.length > heuristic.lint.length) return heuristic;
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

async function assertQueueQuota(auth: AuthClaims): Promise<void> {
  const [perUser, perTenant] = await Promise.all([
    consume('jd-draft-queue-user', auth.userId, QUEUE_LIMIT_PER_USER.windowMs, QUEUE_LIMIT_PER_USER.max),
    consume('jd-draft-queue-tenant', auth.tenantId, QUEUE_LIMIT_PER_TENANT.windowMs, QUEUE_LIMIT_PER_TENANT.max),
  ]);
  if (!perUser.allowed || !perTenant.allowed) {
    throw new HttpError(429, 'You have asked for a lot of new drafts. Try again later, or paste your own job description.');
  }
}

function assertBand(value: string): BandId {
  if (isBandId(value)) return value;
  throw new HttpError(400, 'Unknown experience band.');
}
