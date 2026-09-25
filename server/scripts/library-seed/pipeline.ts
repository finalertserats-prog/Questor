import { z } from 'zod';
import type { BandId } from '../../src/engines/experienceBands.js';
import { parseJsonLoose } from '../../src/providers/llm/index.js';
import type { LlmProvider } from '../../src/providers/llm/types.js';
import { buildCriticPrompt, CRITIC_PROMPT_VERSION } from '../../src/library/critic.js';
import { checkDuplicate, dedupeWithinBatch, LexicalShingleBackend, type DedupeVerdict } from '../../src/library/dedupe.js';
import { buildQuestionsPrompt, buildStandardPrompt, GENERATOR_PROMPT_VERSION, generatedQuestionSchema, standardSchema, type GeneratedQuestion, type PoolContext } from '../../src/library/generator.js';
import { lintAnchors, lintQuestionText, type LintResult } from '../../src/library/linter.js';
import { decideGate } from '../../src/library/policy.js';
import { nextFormsFor } from '../../src/library/poolTargets.js';
import type { SeedPool } from '../../src/library/seedExport.js';
import { questionRecordSchema, standardRecordSchema, type QuestionRecord, type StandardRecord } from '../../src/library/seedFormat.js';
import { criticVerdictSchema, DEFAULT_POLICY, type CriticVerdict } from '../../src/library/types.js';
import type { Lane } from './lanes.js';
import { LaneCallError, LaneLimitError } from './provider.js';
import type { Assignment, LaneScheduler } from './scheduler.js';

/**
 * One pool through the Brahmastra loop, with the library's own prompts:
 *
 *   standard (generator lane, only when the family has none) → questions
 *   (generator lane) → local linter + dedupe → critic (a different lane, the
 *   L0 rubric) → local policy check → tie-break on a critic failure (the third
 *   lane) → accepted records
 *
 * Local checks only save calls and file space: the import runs every gate
 * again on the server. Malformed items are dropped one by one with a reason.
 */

export type Stage = 'parse' | 'lint' | 'dedupe' | 'critic' | 'tiebreak' | 'format';

export interface RejectedItem {
  readonly stage: Stage;
  readonly reasons: readonly string[];
  readonly questionText?: string;
}

export interface PoolResult {
  /** Written by this pool's generator because the family had no standard yet. */
  readonly standard: StandardRecord | null;
  readonly accepted: readonly QuestionRecord[];
  readonly rejected: readonly RejectedItem[];
  readonly assignment: Assignment;
}

export interface PipelineDeps {
  readonly scheduler: LaneScheduler;
  readonly provider: (lane: Lane) => LlmProvider;
  readonly runId: string;
  readonly now: () => Date;
  readonly perPool: number;
  readonly tiebreak: boolean;
  readonly log: (event: Record<string, unknown>) => void;
}

/** The pool cannot finish this attempt (a lane limit, a failed call, an unusable standard); it is retried later. */
export class PoolStageError extends Error {
  /** `laneLimited`: the lane, not the pool, was the problem; the attempt is not counted against the pool. */
  constructor(readonly reason: string, readonly laneLimited = false) {
    super(reason);
    this.name = 'PoolStageError';
  }
}

export function standardKeyOf(p: { readonly familySlug: string; readonly competencyKey: string; readonly band: string }): string {
  return `${p.familySlug}|${p.competencyKey}|${p.band}`;
}

export function contextFor(pool: SeedPool, alsoAvoid: readonly string[]): PoolContext {
  return {
    pool: { scope: 'global', tenantId: null, roleSlug: pool.roleSlug, familySlug: pool.familySlug, competencyKey: pool.competencyKey, band: pool.band },
    roleTitle: pool.roleTitle, familyName: pool.familyName, competency: pool.competency, band: pool.band as BandId, jdText: pool.jdText,
    existingQuestions: [...pool.existingQuestions, ...alsoAvoid],
  };
}

async function call(deps: PipelineDeps, lane: Lane, role: string, pool: string, prompt: { readonly system: string; readonly user: string }): Promise<string> {
  try {
    const result = await deps.scheduler.run(lane, () => deps.provider(lane).generate([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]));
    deps.scheduler.succeeded(lane);
    deps.log({ event: 'call', lane, role, pool, ok: true, ms: result.latencyMs });
    return result.text;
  } catch (err) {
    if (err instanceof LaneLimitError) {
      deps.scheduler.limited(lane, err.until);
      deps.log({ event: err.beforeCall ? 'skipped' : 'call', lane, role, pool, ok: false, reason: 'usage_limit', until: err.until.toISOString(), untilParsed: err.parsed });
      throw new PoolStageError(`${role}:${lane}:usage_limit`, true);
    }
    if (err instanceof LaneCallError) {
      deps.scheduler.failed(lane);
      deps.log({ event: 'call', lane, role, pool, ok: false, reason: err.reason });
      throw new PoolStageError(`${role}:${lane}:${err.reason}`);
    }
    throw err;
  }
}

function parseLoose(text: string): unknown {
  try {
    return parseJsonLoose(text);
  } catch {
    return undefined;
  }
}

async function ensureAnchors(pool: SeedPool, ctx: PoolContext, gen: Lane, known: ReadonlyMap<string, StandardRecord>, deps: PipelineDeps): Promise<{ readonly anchors: readonly string[]; readonly created: StandardRecord | null }> {
  if (pool.standard && pool.standard.anchors.length >= 2) return { anchors: pool.standard.anchors, created: null };
  const cached = known.get(standardKeyOf(pool));
  if (cached) return { anchors: cached.anchors, created: null };
  const text = await call(deps, gen, 'standard', pool.key, buildStandardPrompt(ctx));
  const parsed = standardSchema.safeParse(parseLoose(text));
  if (!parsed.success) throw new PoolStageError(`standard:${gen}:malformed`);
  const lint = lintAnchors(parsed.data.anchors);
  if (!lint.ok) throw new PoolStageError(`standard:${gen}:lint:${lint.errors.map((e) => e.code).join('+')}`);
  const record = standardRecordSchema.safeParse({
    kind: 'standard', familySlug: pool.familySlug, competencyKey: pool.competencyKey, band: pool.band,
    anchors: parsed.data.anchors, weakSigns: parsed.data.weakSigns,
    provenance: { source: 'brahmastra', runId: deps.runId, generatorLane: gen, generatorPromptVersion: GENERATOR_PROMPT_VERSION, generatedAt: deps.now().toISOString() },
  });
  if (!record.success) throw new PoolStageError(`standard:${gen}:format`);
  return { anchors: record.data.anchors, created: record.data };
}

/** Each item of a questions reply on its own: one bad item never costs the batch. */
export function parseQuestions(text: string): { readonly questions: GeneratedQuestion[]; readonly dropped: RejectedItem[] } {
  const parsed = parseLoose(text);
  const list = (parsed as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(list)) return { questions: [], dropped: [{ stage: 'parse', reasons: ['malformed:no_questions_array'] }] };
  const questions: GeneratedQuestion[] = [];
  const dropped: RejectedItem[] = [];
  for (const item of list) {
    const q = generatedQuestionSchema.safeParse(item);
    if (!q.success) {
      const issue = q.error.issues[0];
      dropped.push({ stage: 'parse', reasons: [`malformed:${issue.path.join('.') || 'item'}`] });
    } else if (q.data.form === 'other') {
      dropped.push({ stage: 'parse', reasons: ['malformed:form_other'], questionText: q.data.questionText });
    } else {
      questions.push(q.data);
    }
  }
  return { questions, dropped };
}

const numberedVerdictSchema = criticVerdictSchema.extend({ n: z.number().int().min(1) });

/** Verdicts matched by number; a missing or malformed verdict is null, never shifted onto another question. */
export function parseVerdicts(text: string, count: number): (CriticVerdict | null)[] {
  const list = (parseLoose(text) as { verdicts?: unknown } | undefined)?.verdicts;
  const byNumber = new Map<number, CriticVerdict>();
  if (Array.isArray(list)) {
    for (const item of list) {
      const v = numberedVerdictSchema.safeParse(item);
      if (v.success && !byNumber.has(v.data.n)) {
        const { n, ...verdict } = v.data;
        byNumber.set(n, verdict);
      }
    }
  }
  return Array.from({ length: count }, (_, i) => byNumber.get(i + 1) ?? null);
}

const OPEN_STRATUM = { cleanApprovals: Number.MAX_SAFE_INTEGER, tightenedRemaining: 0 } as const;

function localGate(verdict: CriticVerdict | null, lint: LintResult, dedupe: DedupeVerdict) {
  return decideGate({ critic: verdict, lint, dedupe, stratum: OPEN_STRATUM, policy: DEFAULT_POLICY });
}

interface Candidate {
  readonly question: GeneratedQuestion;
  readonly lint: LintResult;
  readonly dedupe: DedupeVerdict;
}

async function critique(deps: PipelineDeps, lane: Lane, role: 'critic' | 'tiebreak', ctx: PoolContext, pool: SeedPool, candidates: readonly Candidate[], anchors: readonly string[]): Promise<(CriticVerdict | null)[]> {
  const text = await call(deps, lane, role, pool.key, buildCriticPrompt(ctx, candidates.map((c) => c.question), anchors));
  return parseVerdicts(text, candidates.length);
}

export async function runPool(
  pool: SeedPool,
  assignment: Assignment,
  deps: PipelineDeps,
  state: { readonly knownStandards: ReadonlyMap<string, StandardRecord>; readonly alreadyAccepted: readonly string[] },
): Promise<PoolResult> {
  const { generator: gen, critic: crit } = assignment;
  const ctx = contextFor(pool, state.alreadyAccepted);
  const { anchors, created } = await ensureAnchors(pool, ctx, gen, state.knownStandards, deps);
  const forms = nextFormsFor(pool.formCounts, Math.max(1, deps.perPool));
  const reply = await call(deps, gen, 'generator', pool.key, buildQuestionsPrompt(ctx, forms, anchors));
  const { questions, dropped } = parseQuestions(reply);
  const rejected: RejectedItem[] = [...dropped];

  const thresholds = { near: DEFAULT_POLICY.nearDuplicate, duplicate: DEFAULT_POLICY.duplicate };
  const similarity = new LexicalShingleBackend();
  const inBatch = await dedupeWithinBatch(questions.map((q) => q.questionText), thresholds, similarity);
  const prior = ctx.existingQuestions.map((text, i) => ({ id: String(i), text }));
  const candidates: Candidate[] = [];
  for (const [i, question] of questions.entries()) {
    if (inBatch.has(i)) {
      rejected.push({ stage: 'dedupe', reasons: ['dedupe:within_batch'], questionText: question.questionText });
      continue;
    }
    const lint = lintQuestionText(question.questionText);
    if (!lint.ok) {
      rejected.push({ stage: 'lint', reasons: lint.errors.map((e) => `lint:${e.code}`), questionText: question.questionText });
      continue;
    }
    const dedupe = await checkDuplicate(question.questionText, prior, thresholds, similarity);
    if (dedupe.kind === 'duplicate') {
      rejected.push({ stage: 'dedupe', reasons: ['dedupe:duplicate'], questionText: question.questionText });
      continue;
    }
    candidates.push({ question, lint, dedupe });
  }

  const verdicts = candidates.length > 0 ? await critique(deps, crit, 'critic', ctx, pool, candidates, anchors) : [];
  const passed: { readonly candidate: Candidate; readonly critic: CriticVerdict; readonly tiebreak?: CriticVerdict }[] = [];
  const disputed: { readonly candidate: Candidate; readonly critic: CriticVerdict; readonly reasons: readonly string[] }[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const verdict = verdicts[i];
    const gate = localGate(verdict, candidate.lint, candidate.dedupe);
    if (!verdict) rejected.push({ stage: 'critic', reasons: ['critic:missing'], questionText: candidate.question.questionText });
    else if (gate.outcome !== 'fail') passed.push({ candidate, critic: verdict });
    else if (deps.tiebreak && assignment.tiebreak && gate.reasons.every((r) => r.startsWith('critic:'))) disputed.push({ candidate, critic: verdict, reasons: gate.reasons });
    else rejected.push({ stage: 'critic', reasons: gate.reasons, questionText: candidate.question.questionText });
  }

  if (disputed.length > 0 && assignment.tiebreak) {
    let tiebreaks: (CriticVerdict | null)[] = [];
    try {
      tiebreaks = await critique(deps, assignment.tiebreak, 'tiebreak', ctx, pool, disputed.map((d) => d.candidate), anchors);
    } catch (err) {
      // A tie-break that cannot run leaves the critic's rejection standing; the batch is not retried for it.
      if (!(err instanceof PoolStageError)) throw err;
    }
    for (const [i, d] of disputed.entries()) {
      const verdict = tiebreaks[i] ?? null;
      const gate = verdict ? localGate(verdict, d.candidate.lint, d.candidate.dedupe) : null;
      if (verdict && gate && gate.outcome !== 'fail') passed.push({ candidate: d.candidate, critic: d.critic, tiebreak: verdict });
      else rejected.push({ stage: 'tiebreak', reasons: [...d.reasons, ...(gate ? gate.reasons.map((r) => `tiebreak:${r}`) : ['tiebreak:unavailable'])], questionText: d.candidate.question.questionText });
    }
  }

  const accepted: QuestionRecord[] = [];
  for (const p of passed) {
    const record = questionRecordSchema.safeParse({
      kind: 'question', scope: 'global', roleSlug: pool.roleSlug, familySlug: pool.familySlug, competencyKey: pool.competencyKey, band: pool.band,
      form: p.candidate.question.form, difficultyTag: p.candidate.question.difficultyTag, questionText: p.candidate.question.questionText,
      rationale: p.candidate.question.rationale, anchors: [...anchors], critic: p.critic, ...(p.tiebreak ? { tiebreak: p.tiebreak } : {}),
      provenance: {
        source: 'brahmastra', runId: deps.runId, generatorLane: gen, generatorPromptVersion: GENERATOR_PROMPT_VERSION, generatedAt: deps.now().toISOString(),
        criticLane: crit, criticPromptVersion: CRITIC_PROMPT_VERSION, ...(p.tiebreak && assignment.tiebreak ? { tiebreakLane: assignment.tiebreak } : {}),
      },
    });
    if (record.success) accepted.push(record.data);
    else rejected.push({ stage: 'format', reasons: [`format:${record.error.issues[0]?.path.join('.') ?? ''}`], questionText: p.candidate.question.questionText });
  }
  return { standard: created, accepted, rejected, assignment };
}
