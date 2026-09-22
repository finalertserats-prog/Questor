import { z } from 'zod';
import type { QuestionForm } from '../engines/conversationRuntime.js';

/**
 * Shared shapes for the Question & Answer Library. Pure: no database, no
 * provider. Everything the worker, the policy gate, the routes and the admin
 * screen agree on lives here.
 */

export const ENTRY_STATUSES = ['draft', 'probational', 'live', 'retired', 'rejected'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const GATE_OUTCOMES = ['pass', 'unsure', 'fail'] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

export const ENTRY_SCOPES = ['global', 'org'] as const;
export type EntryScope = (typeof ENTRY_SCOPES)[number];

/**
 * The engine's question forms, spelled out so zod can validate a model's tag
 * and the pool target can spread a pool across them. `satisfies` keeps this
 * list in step with the engine's union: a form added there without being
 * added here fails to compile.
 */
export const QUESTION_FORMS = ['star', 'opinion', 'disagreement', 'hypothetical', 'walkthrough', 'tradeoff', 'retrospective', 'work_sample', 'other'] as const satisfies readonly QuestionForm[];
export type LibraryForm = (typeof QUESTION_FORMS)[number];

/** Forms a generator may choose; "other" is a classifier's fallback, never a target. */
export const TARGET_FORMS: readonly LibraryForm[] = QUESTION_FORMS.filter((f) => f !== 'other');

export const questionFormSchema = z.enum(QUESTION_FORMS);

/** The engine's non-competency block namespace; no entry may live in it. */
export const RESERVED_ID_PREFIX = '__';

export function isReservedEntryId(id: string): boolean {
  return id.startsWith(RESERVED_ID_PREFIX);
}

/** One aggregate per entry. Only anchors are populated in L0; the rest is reserved. */
export const entryBodySchema = z.object({
  anchors: z.array(z.string().trim().min(1).max(300)).max(12).default([]),
  probes: z.array(z.unknown()).optional(),
  exemplars: z.record(z.unknown()).optional(),
  variants: z.array(z.unknown()).optional(),
  /** The generator's one-line reason this question fits the role; shown to the owner, never asked. */
  rationale: z.string().max(400).optional(),
});
export type EntryBody = z.infer<typeof entryBodySchema>;

export function parseEntryBody(json: string): EntryBody {
  try {
    const parsed = entryBodySchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : { anchors: [] };
  } catch {
    return { anchors: [] };
  }
}

/** The independent critic's verdict on one generated question. */
export const criticVerdictSchema = z.object({
  realQuestion: z.boolean(),
  rightBand: z.boolean(),
  answerable: z.boolean(),
  formCorrect: z.boolean(),
  anchorsLeaked: z.boolean(),
  roleSpecific: z.boolean(),
  confidence: z.number().min(0).max(1),
  notes: z.string().max(600).catch(''),
});
export type CriticVerdict = z.infer<typeof criticVerdictSchema>;

export function parseCriticVerdict(json: string): CriticVerdict | null {
  try {
    const parsed = criticVerdictSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Thresholds a policy version fixes; an entry records which version approved it. */
export interface LibraryPolicySettings {
  readonly version: number;
  readonly promotionUses: number;
  readonly sampleSize: number;
  readonly stratumCleanApprovals: number;
  readonly tightenWindow: number;
  readonly criticPassMin: number;
  readonly criticGreyMin: number;
  readonly nearDuplicate: number;
  readonly duplicate: number;
  readonly noRepeatWindowDays: number;
}

export const DEFAULT_POLICY: LibraryPolicySettings = {
  version: 1,
  promotionUses: 5,
  sampleSize: 20,
  stratumCleanApprovals: 20,
  tightenWindow: 200,
  criticPassMin: 0.8,
  criticGreyMin: 0.55,
  nearDuplicate: 0.5,
  duplicate: 0.8,
  noRepeatWindowDays: 30,
};

/** A pool: one role × competency × band, global or private to an organisation. */
export interface PoolKey {
  readonly scope: EntryScope;
  readonly tenantId: string | null;
  readonly roleSlug: string;
  readonly familySlug: string;
  readonly competencyKey: string;
  readonly band: string;
}

export function poolKeyOf(pool: PoolKey): string {
  return [pool.scope, pool.tenantId ?? '', pool.roleSlug, pool.competencyKey, pool.band].join('|');
}

/** The stratum an entry is sampled and gated in: pool, band, form, generator version and scope. */
export function stratumKeyOf(entry: { readonly scope: string; readonly roleSlug: string; readonly band: string; readonly form: string; readonly generatorPromptVersion: string }): string {
  return [entry.scope, entry.roleSlug, entry.band, entry.form, entry.generatorPromptVersion].join('|');
}

/** What the worker reports about itself; the admin screen shows it as is. */
export const WORKER_STATES = ['running', 'idle', 'paused', 'waiting_for_credits', 'critic_unavailable', 'stopped'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

/** The snapshot a caller stores so a later edit or retirement never changes a past interview. */
export interface EntrySnapshot {
  readonly entryId: string;
  readonly standardId: string | null;
  readonly questionText: string;
  readonly anchors: readonly string[];
  readonly form: LibraryForm;
  readonly difficultyTag: number;
  /** Suggested follow-ups, in the shape the plan stores (domain LibraryProbeSnapshot); empty until L2 writes them. */
  readonly probes: readonly ProbeSnapshot[];
}

const probeFlag = z.enum(['hasSituation', 'hasAction', 'hasResult', 'specific']);
export const probeSnapshotSchema = z.object({
  text: z.string().trim().min(1).max(300),
  when: z.record(probeFlag, z.boolean()).optional(),
});
export type ProbeSnapshot = z.infer<typeof probeSnapshotSchema>;

/** The probes stored in an entry body that have the snapshot's shape; anything else is dropped. */
export function probesOf(body: EntryBody): ProbeSnapshot[] {
  return (body.probes ?? []).flatMap((probe) => {
    const parsed = probeSnapshotSchema.safeParse(probe);
    return parsed.success ? [parsed.data] : [];
  });
}
