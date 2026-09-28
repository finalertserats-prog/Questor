import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { slugifyCatalogName } from '../domain/catalogText.js';
import { logAudit } from '../services/audit.js';
import { checkDuplicate, LexicalShingleBackend, type SimilarityBackend } from './dedupe.js';
import { competenciesOf } from './demand.js';
import { operatorTenantId } from './lifecycle.js';
import { lintAnchors, lintQuestionText, screenInjection } from './linter.js';
import { decideGate, loadPolicy, loadStratum, saveStratum, statusForOutcome, stratumAfterGated, type GateDecision, type StratumState } from './policy.js';
import {
  contentHashOf, effectiveVerdict, laneModel, parseSeedLine, seededPromptVersion, SEED_SOURCE,
  type QuestionRecord, type SeedRecord, type StandardRecord,
} from './seedFormat.js';
import { stratumKeyOf, type LibraryPolicySettings } from './types.js';
import { existingQuestions } from './worker.js';

/**
 * Imports a seed file written offline (seedFormat.ts) through the worker's own
 * gates, in the worker's order:
 *
 *   linter + injection screen → near-duplicate check against the pool and its
 *   family → policy gate (critic verdict, strata) → draft / probational / rejected
 *
 * The critic verdict in the file stands in for the worker's critic call; the
 * policy gate reads it with the same thresholds, so a clean entry goes to
 * probational by policy and the owner sees it through the daily sample.
 * Seeded entries carry their own prompt version, so they form their own strata
 * (sampled and tightened apart from the worker's). Nothing is ever made live.
 *
 * Standards are written only where the family has none; a live standard is
 * never replaced. Re-importing a file writes nothing twice (content hash).
 * Only pools the worker's own demand could produce are accepted: a catalog
 * role in its family, a competency of an approved scorecard of a role linked
 * to it, at a band that role is hired at.
 *
 * Trust boundary: the critic verdicts in the file are taken as written. The
 * import is an operator tool (it needs a shell on the server), the file comes
 * from the owner's own laptop run, and no verdict can make an entry live:
 * probational -> live needs clean uses in interviews, and the daily sample
 * covers seeded strata like any other. seedImportMain holds the worker's lease, so an import and the worker
 * never gate the same pools at once.
 */

export interface LineReason {
  readonly line: number;
  readonly reason: string;
}

export interface SeedImportReport {
  readonly lines: number;
  /** Lines that are not valid records; nothing written. */
  readonly invalid: LineReason[];
  readonly standards: { created: number; existing: number; rejected: { line: number; reasons: string[] }[] };
  readonly questions: { probational: number; queued: number; rejected: number; alreadyImported: number };
  /** Valid question records that cannot become an entry at all (no role, no standard, same lane); nothing written. */
  readonly refused: LineReason[];
  /** How often each gate reason was given across the written entries. */
  readonly reasons: Record<string, number>;
}

export interface SeedImportOptions {
  readonly similarity?: SimilarityBackend;
}

interface Numbered<T> {
  readonly line: number;
  readonly record: T;
}

function emptyReport(lines: number): SeedImportReport {
  return { lines, invalid: [], standards: { created: 0, existing: 0, rejected: [] }, questions: { probational: 0, queued: 0, rejected: 0, alreadyImported: 0 }, refused: [], reasons: {} };
}

function standardKey(r: { readonly familySlug: string; readonly competencyKey: string; readonly band: string }): string {
  return `${r.familySlug}|${r.competencyKey}|${r.band}`;
}

async function liveStandard(key: { readonly familySlug: string; readonly competencyKey: string; readonly band: string }) {
  return prisma.libraryStandard.findFirst({ where: { familySlug: key.familySlug, competencyKey: key.competencyKey, band: key.band, status: 'live' }, orderBy: { version: 'desc' } });
}

function anchorsOf(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    const list = Array.isArray(parsed) ? parsed : (parsed as { anchors?: unknown })?.anchors;
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

interface DemandKeys {
  /** role|competency|band */
  readonly pools: ReadonlySet<string>;
  /** family|competency|band */
  readonly standards: ReadonlySet<string>;
}

/** Every pool the demand queue could hold, at or below target: the import writes nothing outside it. */
async function demandKeys(): Promise<DemandKeys> {
  const roles = await prisma.role.findMany({
    where: { catalogRoleId: { not: null }, experienceBand: { not: null }, status: { not: 'archived' } },
    select: {
      experienceBand: true,
      catalogRole: { select: { title: true, family: { select: { name: true } } } },
      scorecards: { where: { status: 'approved' }, orderBy: { version: 'desc' }, take: 1, select: { profileJson: true } },
    },
  });
  const pools = new Set<string>();
  const standards = new Set<string>();
  for (const role of roles) {
    const profile = role.scorecards[0];
    if (!profile || !role.catalogRole || !role.experienceBand) continue;
    const roleSlug = slugifyCatalogName(role.catalogRole.title);
    const familySlug = slugifyCatalogName(role.catalogRole.family?.name ?? 'General') || 'general';
    for (const competency of competenciesOf(profile.profileJson)) {
      const competencyKey = slugifyCatalogName(competency.name);
      if (!competencyKey) continue;
      pools.add(`${roleSlug}|${competencyKey}|${role.experienceBand}`);
      standards.add(`${familySlug}|${competencyKey}|${role.experienceBand}`);
    }
  }
  return { pools, standards };
}

async function importStandard({ line, record }: Numbered<StandardRecord>, report: SeedImportReport, demand: DemandKeys): Promise<void> {
  if (!demand.standards.has(standardKey(record))) {
    report.standards.rejected.push({ line, reasons: ['seed:not_in_demand'] });
    return;
  }
  // Weak signs are read with the anchors, so they are screened the same way; only the anchor count rules do not apply to them.
  const weakSignErrors = record.weakSigns.length === 0 ? [] : lintAnchors(record.weakSigns).errors.filter((e) => e.code !== 'too_few_anchors');
  const errors = [...lintAnchors(record.anchors).errors, ...weakSignErrors];
  if (errors.length > 0) {
    report.standards.rejected.push({ line, reasons: [...new Set(errors.map((e) => `lint:${e.code}`))] });
    return;
  }
  if (await liveStandard(record)) {
    report.standards.existing += 1;
    return;
  }
  await prisma.libraryStandard.create({
    data: {
      familySlug: record.familySlug, competencyKey: record.competencyKey, band: record.band,
      anchorsJson: JSON.stringify({ anchors: record.anchors, weakSigns: record.weakSigns }),
      generatorPromptVersion: seededPromptVersion(record.provenance.generatorPromptVersion), generatorModel: laneModel(record.provenance.generatorLane),
    },
  });
  report.standards.created += 1;
}

/** Catalog role slug → the family slugs it is filed under (a title can recur across domains). */
async function catalogFamilies(): Promise<Map<string, Set<string>>> {
  const roles = await prisma.catalogRole.findMany({ where: { status: 'active' }, select: { title: true, family: { select: { name: true } } } });
  const out = new Map<string, Set<string>>();
  for (const role of roles) {
    const slug = slugifyCatalogName(role.title);
    const family = slugifyCatalogName(role.family?.name ?? 'General') || 'general';
    out.set(slug, new Set([...(out.get(slug) ?? []), family]));
  }
  return out;
}

function refusalFor(record: QuestionRecord, families: Map<string, Set<string>>, demand: DemandKeys): string | null {
  const known = families.get(record.roleSlug);
  if (!known) return 'seed:unknown_role';
  if (!known.has(record.familySlug)) return 'seed:family_mismatch';
  const { generatorLane, criticLane, tiebreakLane } = record.provenance;
  if (criticLane === generatorLane || tiebreakLane === generatorLane || tiebreakLane === criticLane) return 'seed:same_lane';
  if (record.tiebreak && !tiebreakLane) return 'seed:tiebreak_without_lane';
  if (!demand.pools.has(`${record.roleSlug}|${record.competencyKey}|${record.band}`)) return 'seed:not_in_demand';
  return null;
}

/** Adds seed-specific soft reasons: a clean pass becomes "unsure", a failure stays a failure. */
export function withSeedReasons(decision: GateDecision, soft: readonly string[]): GateDecision {
  if (soft.length === 0 || decision.outcome === 'fail') return decision;
  return { outcome: 'unsure', reasons: [...decision.reasons, ...soft] };
}

function sameAnchors(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x.trim() === b[i]?.trim());
}

interface ImportContext {
  readonly policy: LibraryPolicySettings;
  readonly similarity: SimilarityBackend;
  readonly families: Map<string, Set<string>>;
  readonly demand: DemandKeys;
  readonly strata: Map<string, StratumState>;
  readonly pools: Map<string, { id: string; text: string }[]>;
  readonly standards: Map<string, { readonly id: string; readonly anchors: string[] } | null>;
}

async function cached<K, V>(map: Map<K, V>, key: K, load: () => Promise<V>): Promise<V> {
  if (map.has(key)) return map.get(key) as V;
  const value = await load();
  map.set(key, value);
  return value;
}

type QuestionOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'already' } | { readonly kind: 'written'; readonly decision: GateDecision };

async function importQuestion(record: QuestionRecord, ctx: ImportContext): Promise<QuestionOutcome> {
  const refusal = refusalFor(record, ctx.families, ctx.demand);
  if (refusal) return { kind: 'refused', reason: refusal };
  const contentHash = contentHashOf(record);
  if (await prisma.libraryEntry.findUnique({ where: { contentHash }, select: { id: true } })) return { kind: 'already' };
  const standard = await cached(ctx.standards, standardKey(record), async () => {
    const row = await liveStandard(record);
    return row ? { id: row.id, anchors: anchorsOf(row.anchorsJson) } : null;
  });
  if (!standard) return { kind: 'refused', reason: 'seed:no_standard' };

  const poolKey = `${record.roleSlug}|${record.competencyKey}|${record.band}`;
  const existing = await cached(ctx.pools, poolKey, () => existingQuestions(record));
  const lint = lintQuestionText(record.questionText);
  const rationaleClean = screenInjection(record.rationale).clean;
  const dedupe = await checkDuplicate(record.questionText, existing, { near: ctx.policy.nearDuplicate, duplicate: ctx.policy.duplicate }, ctx.similarity);
  const generatorPromptVersion = seededPromptVersion(record.provenance.generatorPromptVersion);
  const stratumKey = stratumKeyOf({ scope: record.scope, roleSlug: record.roleSlug, band: record.band, form: record.form, generatorPromptVersion });
  const stratum = await cached(ctx.strata, stratumKey, () => loadStratum(stratumKey));
  const { verdict, split } = effectiveVerdict(record);
  const base = decideGate({ critic: verdict, lint, dedupe, stratum, policy: ctx.policy });
  const hard = rationaleClean ? base : { outcome: 'fail' as const, reasons: [...(base.outcome === 'fail' ? base.reasons : []), 'lint:rationale_injection'] };
  const decision = withSeedReasons(hard, [
    ...(split ? ['seed:critics_split'] : []),
    ...(sameAnchors(record.anchors, standard.anchors) ? [] : ['seed:anchors_changed']),
  ]);
  const status = statusForOutcome(decision.outcome);
  const reason = decision.reasons.join(',');
  const { provenance } = record;
  try {
    const created = await prisma.libraryEntry.create({
      data: {
        scope: record.scope, tenantId: null, roleSlug: record.roleSlug, familySlug: record.familySlug, competencyKey: record.competencyKey,
        competencyVersion: record.competencyVersion ?? null, band: record.band, form: record.form, questionText: record.questionText,
        bodyJson: JSON.stringify({ anchors: standard.anchors, rationale: record.rationale }),
        status, gateOutcome: decision.outcome, gateReason: reason, stratumKey, difficultyTag: record.difficultyTag, standardId: standard.id,
        generatorPromptVersion, generatorModel: laneModel(provenance.generatorLane),
        criticModel: provenance.tiebreakLane ? `${laneModel(provenance.criticLane)}+${laneModel(provenance.tiebreakLane)}` : laneModel(provenance.criticLane),
        criticVerdictJson: JSON.stringify(verdict), policyVersion: ctx.policy.version, createdBy: SEED_SOURCE,
        contentHash, provenanceJson: JSON.stringify({ ...provenance, critic: record.critic, ...(record.tiebreak ? { tiebreak: record.tiebreak } : {}) }),
      },
    });
    await prisma.libraryReview.create({
      data: { entryId: created.id, actor: 'policy', action: 'gated', fromStatus: 'draft', toStatus: status, reason: reason.slice(0, 1000), sampleStratum: stratumKey },
    });
    if (decision.outcome === 'unsure' && stratum.tightenedRemaining > 0) ctx.strata.set(stratumKey, stratumAfterGated(stratum));
    existing.push({ id: created.id, text: created.questionText });
    return { kind: 'written', decision };
  } catch (err) {
    // Two imports of one file at once: the unique hash lets exactly one write it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { kind: 'already' };
    throw err;
  }
}

function tally(report: SeedImportReport, decision: GateDecision): void {
  const bucket = decision.outcome === 'pass' ? 'probational' : decision.outcome === 'unsure' ? 'queued' : 'rejected';
  report.questions[bucket] += 1;
  for (const reason of decision.reasons) report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
}

/** One audit event per import, under the platform operator's organisation, with counts only. */
async function auditImport(report: SeedImportReport): Promise<void> {
  const tenantId = await operatorTenantId();
  if (!tenantId) return;
  await logAudit({
    tenantId, actorType: 'system', actorId: SEED_SOURCE, action: 'library.seed.imported', entityType: 'LibraryEntry',
    after: { lines: report.lines, invalid: report.invalid.length, refused: report.refused.length, standards: { ...report.standards, rejected: report.standards.rejected.length }, questions: report.questions },
  });
}

/** Imports the lines of a seed file (blank lines ignored). Standards first, then questions in file order. */
export async function importSeedLines(lines: readonly string[], opts: SeedImportOptions = {}): Promise<SeedImportReport> {
  const numbered = lines.map((text, i) => ({ line: i + 1, text: text.trim() })).filter((l) => l.text.length > 0);
  const report = emptyReport(numbered.length);
  const parsed: Numbered<SeedRecord>[] = [];
  for (const { line, text } of numbered) {
    const result = parseSeedLine(text);
    if (result.ok) parsed.push({ line, record: result.record });
    else report.invalid.push({ line, reason: result.reason });
  }
  const demand = await demandKeys();
  for (const item of parsed) {
    if (item.record.kind === 'standard') await importStandard({ line: item.line, record: item.record }, report, demand);
  }
  const ctx: ImportContext = {
    policy: await loadPolicy(), similarity: opts.similarity ?? new LexicalShingleBackend(), families: await catalogFamilies(), demand,
    strata: new Map(), pools: new Map(), standards: new Map(),
  };
  for (const item of parsed) {
    if (item.record.kind !== 'question') continue;
    const outcome = await importQuestion(item.record, ctx);
    if (outcome.kind === 'refused') report.refused.push({ line: item.line, reason: outcome.reason });
    else if (outcome.kind === 'already') report.questions.alreadyImported += 1;
    else tally(report, outcome.decision);
  }
  for (const [key, state] of ctx.strata) await saveStratum(key, state);
  await auditImport(report);
  return report;
}
