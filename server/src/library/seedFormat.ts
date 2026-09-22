import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BANDS } from '../engines/experienceBands.js';
import { criticVerdictSchema, TARGET_FORMS, type CriticVerdict, type LibraryForm } from './types.js';

/**
 * The file format for offline seed content: one JSON record per line, written
 * on the owner's laptop by `scripts/library-seed` (the Brahmastra CLIs) and
 * read by the import (seedImport.ts), which puts every question through the
 * same gates as the worker's own output.
 *
 * Nothing in a file is trusted. The schema is strict, the scope is global only
 * (organisation pools are written from organisation text, which never leaves
 * the server), and the content hash is computed here, never read from the file.
 */

export const SEED_SOURCE = 'brahmastra';
export const SEED_LANES = ['claude', 'codex', 'gemini'] as const;
export type SeedLane = (typeof SEED_LANES)[number];
export const seedLaneSchema = z.enum(SEED_LANES);

const BAND_IDS = BANDS.map((b) => b.id) as [string, ...string[]];
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/, 'expected a lowercase slug');
const versionSchema = z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/, 'expected a version tag');
const lineTextSchema = z.string().trim().min(3).max(300);
const targetFormSchema = z.enum(TARGET_FORMS as unknown as [LibraryForm, ...LibraryForm[]]);

const provenanceBase = {
  source: z.literal(SEED_SOURCE),
  runId: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  generatorLane: seedLaneSchema,
  generatorPromptVersion: versionSchema,
  generatedAt: z.string().datetime(),
};

export const standardProvenanceSchema = z.object(provenanceBase).strict();

export const questionProvenanceSchema = z.object({
  ...provenanceBase,
  criticLane: seedLaneSchema,
  criticPromptVersion: versionSchema,
  /** Present only when the first critic failed the question and a third lane was asked. */
  tiebreakLane: seedLaneSchema.optional(),
}).strict();
export type QuestionProvenance = z.infer<typeof questionProvenanceSchema>;

export const standardRecordSchema = z.object({
  kind: z.literal('standard'),
  familySlug: slugSchema,
  competencyKey: slugSchema,
  band: z.enum(BAND_IDS),
  anchors: z.array(lineTextSchema).min(2).max(12),
  weakSigns: z.array(lineTextSchema).max(10).default([]),
  provenance: standardProvenanceSchema,
}).strict();
export type StandardRecord = z.infer<typeof standardRecordSchema>;

export const questionRecordSchema = z.object({
  kind: z.literal('question'),
  scope: z.literal('global'),
  roleSlug: slugSchema,
  familySlug: slugSchema,
  competencyKey: slugSchema,
  competencyVersion: z.string().max(40).optional(),
  band: z.enum(BAND_IDS),
  form: targetFormSchema,
  difficultyTag: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  questionText: z.string().trim().min(10).max(700),
  rationale: z.string().trim().max(400).default(''),
  /** The anchors the critic judged the question against. */
  anchors: z.array(lineTextSchema).min(2).max(12),
  critic: criticVerdictSchema.strict(),
  tiebreak: criticVerdictSchema.strict().optional(),
  provenance: questionProvenanceSchema,
}).strict();
export type QuestionRecord = z.infer<typeof questionRecordSchema>;

export const seedRecordSchema = z.discriminatedUnion('kind', [standardRecordSchema, questionRecordSchema]);
export type SeedRecord = z.infer<typeof seedRecordSchema>;

export type ParsedLine = { readonly ok: true; readonly record: SeedRecord } | { readonly ok: false; readonly reason: string };

/** One line of a seed file, or the first reason it is unusable. Never throws. */
export function parseSeedLine(line: string): ParsedLine {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'json:invalid' };
  }
  const parsed = seedRecordSchema.safeParse(json);
  if (parsed.success) return { ok: true, record: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, reason: `schema:${issue.path.join('.') || '(root)'}:${issue.code}` };
}

/** Case, width and spacing do not make a new question. */
export function normaliseQuestionText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The idempotency key for an imported question: its pool and its normalised text. */
export function contentHashOf(record: Pick<QuestionRecord, 'scope' | 'roleSlug' | 'competencyKey' | 'band' | 'questionText'>): string {
  const key = [record.scope, record.roleSlug, record.competencyKey, record.band, normaliseQuestionText(record.questionText)].join('\u0000');
  return createHash('sha256').update(key).digest('hex');
}

/**
 * The prompt version an imported entry is stamped with. Distinct from the
 * worker's own, so seeded entries form their own strata and every one of them
 * goes through the owner queue until the owner has approved twenty of that
 * stratum untouched, exactly as a new generator prompt version would.
 */
export function seededPromptVersion(generatorPromptVersion: string): string {
  return `${generatorPromptVersion}+${SEED_SOURCE}`;
}

/** The model name recorded for a lane, e.g. "brahmastra:codex". */
export function laneModel(lane: SeedLane): string {
  return `${SEED_SOURCE}:${lane}`;
}

/**
 * The verdict the gate sees. A tie-break exists only when the first critic
 * failed the question: the third lane's verdict decides, and the split itself
 * is a reason for the owner to look (the importer adds it as a soft reason).
 */
export function effectiveVerdict(record: Pick<QuestionRecord, 'critic' | 'tiebreak'>): { readonly verdict: CriticVerdict; readonly split: boolean } {
  return record.tiebreak ? { verdict: record.tiebreak, split: true } : { verdict: record.critic, split: false };
}
