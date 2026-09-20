import { prisma } from '../db.js';
import type { DedupeVerdict } from './dedupe.js';
import type { LintResult } from './linter.js';
import { DEFAULT_POLICY, type CriticVerdict, type EntryStatus, type GateOutcome, type LibraryPolicySettings } from './types.js';

/**
 * The policy gate. Pure decision first, so every branch is unit-tested; the
 * database wrappers below only load the inputs and persist stratum state.
 *
 *   pass   → probational
 *   unsure → owner queue (still a draft)
 *   fail   → rejected, with the reasons kept for the generator's next batch
 *
 * A stratum (pool × band × form × generator version × scope) is "new" until
 * the owner has approved twenty of its entries untouched, and "tightened"
 * for 200 entries after a rejection in the daily sample. Both send every
 * entry of the stratum to the owner queue, never straight to probational.
 */

export interface StratumGate {
  readonly cleanApprovals: number;
  readonly tightenedRemaining: number;
}

export interface StratumState extends StratumGate {
  readonly approvals: number;
  readonly rejections: number;
}

export interface GateInput {
  readonly critic: CriticVerdict | null;
  readonly lint: LintResult;
  readonly dedupe: DedupeVerdict;
  readonly stratum: StratumGate;
  readonly policy: LibraryPolicySettings;
}

export interface GateDecision {
  readonly outcome: GateOutcome;
  readonly reasons: readonly string[];
}

function criticReasons(critic: CriticVerdict | null, policy: LibraryPolicySettings): { readonly hard: string[]; readonly soft: string[] } {
  if (!critic) return { hard: ['critic:missing'], soft: [] };
  const hard: string[] = [];
  const soft: string[] = [];
  if (!critic.realQuestion) hard.push('critic:not_a_question');
  if (!critic.roleSpecific) hard.push('critic:generic');
  if (critic.anchorsLeaked) hard.push('critic:anchors_leaked');
  if (critic.confidence < policy.criticGreyMin) hard.push('critic:low_confidence');
  else if (critic.confidence < policy.criticPassMin) soft.push('critic:grey_confidence');
  if (!critic.rightBand) soft.push('critic:wrong_band');
  if (!critic.answerable) soft.push('critic:not_answerable');
  if (!critic.formCorrect) soft.push('critic:wrong_form');
  return { hard, soft };
}

export function decideGate(input: GateInput): GateDecision {
  const critic = criticReasons(input.critic, input.policy);
  const hard = [
    ...critic.hard,
    ...input.lint.errors.map((f) => `lint:${f.code}`),
    ...(input.dedupe.kind === 'duplicate' ? ['dedupe:duplicate'] : []),
  ];
  if (hard.length > 0) return { outcome: 'fail', reasons: hard };
  const soft = [
    ...critic.soft,
    ...input.lint.warnings.map((f) => `lint:${f.code}`),
    ...(input.dedupe.kind === 'near' ? ['dedupe:near'] : []),
  ];
  if (input.stratum.tightenedRemaining > 0) soft.push('stratum:tightened');
  else if (input.stratum.cleanApprovals < input.policy.stratumCleanApprovals) soft.push('stratum:new');
  if (soft.length > 0) return { outcome: 'unsure', reasons: soft };
  return { outcome: 'pass', reasons: [] };
}

export function statusForOutcome(outcome: GateOutcome): EntryStatus {
  if (outcome === 'pass') return 'probational';
  if (outcome === 'fail') return 'rejected';
  return 'draft';
}

export function stratumOpen(stratum: StratumGate, policy: LibraryPolicySettings): boolean {
  return stratum.tightenedRemaining === 0 && stratum.cleanApprovals >= policy.stratumCleanApprovals;
}

/** After the owner approves an entry; `clean` means approved as generated, not edited first. */
export function stratumAfterApproval(state: StratumState, clean: boolean): StratumState {
  return { ...state, approvals: state.approvals + 1, cleanApprovals: clean ? state.cleanApprovals + 1 : state.cleanApprovals };
}

/** After a rejection in the daily sample: the next `tightenWindow` entries go to the owner. */
export function stratumAfterRejection(state: StratumState, policy: LibraryPolicySettings): StratumState {
  return { ...state, rejections: state.rejections + 1, tightenedRemaining: policy.tightenWindow };
}

/** One entry has passed through a tightened stratum's gate. */
export function stratumAfterGated(state: StratumState): StratumState {
  return state.tightenedRemaining > 0 ? { ...state, tightenedRemaining: state.tightenedRemaining - 1 } : state;
}

// --- Persistence -------------------------------------------------------------

const EMPTY_STRATUM: StratumState = { cleanApprovals: 0, approvals: 0, rejections: 0, tightenedRemaining: 0 };

export async function loadStratum(key: string): Promise<StratumState> {
  const row = await prisma.libraryStratum.findUnique({ where: { key } });
  return row ? { cleanApprovals: row.cleanApprovals, approvals: row.approvals, rejections: row.rejections, tightenedRemaining: row.tightenedRemaining } : EMPTY_STRATUM;
}

export async function saveStratum(key: string, state: StratumState): Promise<void> {
  await prisma.libraryStratum.upsert({ where: { key }, create: { key, ...state }, update: { ...state } });
}

/** The current policy row, created with the defaults on first use so every entry records a real version. */
export async function loadPolicy(): Promise<LibraryPolicySettings> {
  const row = await prisma.libraryPolicy.findFirst({ orderBy: { version: 'desc' } });
  if (row) {
    return {
      version: row.version, promotionUses: row.promotionUses, sampleSize: row.sampleSize, stratumCleanApprovals: row.stratumCleanApprovals,
      tightenWindow: row.tightenWindow, criticPassMin: row.criticPassMin, criticGreyMin: row.criticGreyMin, nearDuplicate: row.nearDuplicate,
      duplicate: row.duplicate, noRepeatWindowDays: row.noRepeatWindowDays,
    };
  }
  const { version, ...defaults } = DEFAULT_POLICY;
  await prisma.libraryPolicy.upsert({ where: { version }, create: { version, ...defaults }, update: {} });
  return DEFAULT_POLICY;
}
