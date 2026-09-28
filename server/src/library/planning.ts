import { config } from '../config.js';
import { prisma, parseJsonOptional } from '../db.js';
import { slugifyCatalogName } from '../domain/catalogText.js';
import type { Competency, CvSignal, FitScore, InterviewPlan } from '../domain/types.js';
import { BANDS } from '../engines/experienceBands.js';
import { logger } from '../logger.js';
import { orgLibrarySettings } from './orgSettings.js';
import { applyLadders, cvSignalsFor, isCompetencyBlock, unavailableLibrary, type LadderPlanInput } from './planLadders.js';
import { loadPolicy } from './policy.js';
import { selectLadders, type Ladders } from './select.js';

/**
 * The planner's side of the library: after the built-in plan is made, ask the
 * library for a ladder per competency block and store what it returns on the
 * plan (library/planLadders.ts decides which blocks use it).
 *
 * It never fails an interview. With LIBRARY_ENABLED off, or the organisation's
 * switch off, the plan comes back untouched — the same object, no query made.
 * Anything else that goes wrong (the role is not in the catalog, the read
 * errors or is slow) leaves every block on the built-in bank, as today, with
 * the reason written on the plan.
 */

/** Longest the planner waits for the library before planning without it. */
export const SELECT_TIMEOUT_MS = 4000;

export interface LibraryPlanContext {
  readonly tenantId: string;
  readonly roleId: string;
  readonly candidateId: string;
  /** The scorecard the plan was built from: the rubric version the anchors belong to. */
  readonly scorecardId: string;
  readonly competencies: readonly Pick<Competency, 'id' | 'name'>[];
  readonly fit?: FitScore;
  /** A session being re-planned: its own earlier ladders are not "already asked". */
  readonly replanningSessionId?: string;
  readonly now?: Date;
  readonly rng?: () => number;
  /** For tests: stands in for the library's read. */
  readonly select?: typeof selectLadders;
}

const BAND_IDS = new Set<string>(BANDS.map((b) => b.id));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`library select timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Every entry this candidate has been offered in an earlier interview, from
 * the ladders stored on those plans: a retake must not put the same question
 * to the same person, and an unfinished first attempt wrote no usage rows.
 */
async function entriesOfferedTo(tenantId: string, candidateId: string, exceptSessionId?: string): Promise<string[]> {
  const plans = await prisma.interviewPlanVersion.findMany({
    where: { session: { tenantId, candidateId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) } },
    select: { id: true, planJson: true },
  });
  const ids = new Set<string>();
  for (const row of plans) {
    const plan = parseJsonOptional<Partial<InterviewPlan>>(row.planJson, {}, { model: 'InterviewPlanVersion', id: row.id, field: 'planJson' });
    for (const block of plan.blocks ?? []) for (const rung of block.library?.ladder ?? []) ids.add(rung.entryId);
  }
  return [...ids];
}

export async function attachLibrary(plan: InterviewPlan, ctx: LibraryPlanContext): Promise<InterviewPlan> {
  if (!config.library.enabled) return plan;
  try {
    return await planWithLibrary(plan, ctx);
  } catch (err) {
    // Reading the organisation or the role failed: plan exactly as without the library.
    logger.warn({ tenantId: ctx.tenantId, roleId: ctx.roleId, err: err instanceof Error ? err.message : String(err) }, 'Library planning skipped');
    return plan;
  }
}

async function planWithLibrary(plan: InterviewPlan, ctx: LibraryPlanContext): Promise<InterviewPlan> {
  const tenant = await prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { policyJson: true, isDemo: true } });
  if (!tenant) return plan;
  const policyJson = parseJsonOptional<Record<string, unknown>>(tenant.policyJson, {}, { model: 'Tenant', id: ctx.tenantId, field: 'policyJson' });
  // Decided before anything else is read: an organisation with it off costs one row.
  if (orgLibrarySettings(policyJson, { isDemo: tenant.isDemo, defaultWindowDays: 1 }).mode === 'off') return plan;
  const policy = await loadPolicy();
  const settings = orgLibrarySettings(policyJson, { isDemo: tenant.isDemo, defaultWindowDays: policy.noRepeatWindowDays });
  if (settings.mode === 'off') return plan;
  const mode = settings.mode;

  const role = await prisma.role.findUnique({ where: { id: ctx.roleId }, select: { experienceBand: true, catalogRole: { select: { title: true } } } });
  const roleSlug = role?.catalogRole ? slugifyCatalogName(role.catalogRole.title) : '';
  const band = role?.experienceBand ?? '';
  const meta: LadderPlanInput['meta'] = {
    rubricVersion: ctx.scorecardId, roleSlug, band, windowDays: settings.windowDays, selectedAt: (ctx.now ?? new Date()).toISOString(),
  };
  const competencyKeys: Record<string, string> = {};
  for (const block of plan.blocks.filter(isCompetencyBlock)) {
    const name = ctx.competencies.find((c) => c.id === block.competencyId)?.name ?? block.competencyName;
    const key = slugifyCatalogName(name);
    if (key) competencyKeys[block.competencyId] = key;
  }
  if (!roleSlug || !BAND_IDS.has(band)) return unavailableLibrary(plan, mode, meta, 'role_not_in_catalog', competencyKeys);

  const cvById = cvSignalsFor(ctx.fit, ctx.competencies);
  const cvByKey: Record<string, CvSignal> = {};
  for (const [id, signal] of Object.entries(cvById)) if (competencyKeys[id]) cvByKey[competencyKeys[id]] = signal;

  let ladders: Ladders;
  try {
    const excludeEntryIds = await entriesOfferedTo(ctx.tenantId, ctx.candidateId, ctx.replanningSessionId);
    ladders = await withTimeout((ctx.select ?? selectLadders)({
      tenantId: ctx.tenantId, roleSlug, band, competencyKeys: [...new Set(Object.values(competencyKeys))],
      // Probational entries are asked only where they can be measured: the trial, and the demo sandbox.
      includeProbational: mode === 'trial' || tenant.isDemo,
      windowDays: settings.windowDays, cvSignals: cvByKey, excludeEntryIds,
      ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.rng ? { rng: ctx.rng } : {}),
    }), SELECT_TIMEOUT_MS);
  } catch (err) {
    logger.warn({ tenantId: ctx.tenantId, roleId: ctx.roleId, err: err instanceof Error ? err.message : String(err) }, 'Library select failed; planning from the built-in bank');
    return unavailableLibrary(plan, mode, meta, 'select_failed', competencyKeys);
  }
  return applyLadders(plan, {
    mode, ladders, competencyKeys, trialPercent: settings.trialPercent, cvSignals: cvById, rng: ctx.rng ?? Math.random, meta,
  });
}
