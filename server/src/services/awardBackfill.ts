import { prisma, parseJsonOptional } from '../db.js';
import { AWARD_TIERS, awardsForPromotion, TIER_LABELS, type AwardTier } from '../domain/candidateAwards.js';
import { parseStages, type PipelineStage } from '../domain/pipelineStages.js';
import { awardOnPromotion, isAwardConflict, auditAwards, type StruckAward } from './candidateAwards.js';

/**
 * The credentials the ladder owes candidates who were moved before it worked.
 *
 * ---- What went wrong, and therefore what is owed
 *
 * A tier is earned when a candidate is promoted OUT of it. Until the
 * "HR decides" lane, two paths moved people without asking the award engine
 * anything:
 *
 *   - `applyPipelineEvent` wrote a stage and never called it. `interview.assessed`
 *     targets the human-conducted stage, so it carried candidates out of Silver
 *     and struck nothing. Silver is the only tier an automatic move could ever
 *     have earned — events never reach the last stage, so nothing automatic has
 *     ever left Gold.
 *   - `resolveDecision` vaulted a candidate past the round being approved.
 *     Bronze → Gold in one move earns nothing, because `awardsForPromotion`
 *     reads the tier being LEFT and Bronze is never earned by leaving.
 *
 * ---- How it decides what was earned, and why it replays rather than infers
 *
 * From the audit trail, not from where the candidate stands now. "Every tier
 * below the current stage" is the tempting rule and it is wrong in the one
 * case the product cares most about: a finalisation from Silver puts a
 * candidate at Diamond having earned Silver and Diamond and NOT Gold, because
 * nobody interviewed them at Gold. Inferring from the stage would mint that
 * Gold, and a Gold certificate claiming rounds that never happened is a
 * document a person may hand to an employer.
 *
 * So every recorded move is replayed through the product's own
 * `awardsForPromotion`, with one distinction the trail makes and the rule
 * needs:
 *
 *   - a FINALISATION may vault, and is replayed as the single move it was;
 *   - an ADVANCE may not, and is expanded into the one-stage steps the
 *     product would take today, so a historical Bronze → Gold decision earns
 *     the Silver it passed through.
 *
 * ---- What it will not do
 *
 * It never mints Bronze. Bronze is the hiring team's reading of a CV, is
 * never issued to the candidate, and is earned by an approved scorecard
 * rather than by any move — `awardsForPromotion` cannot return it, and the
 * filter below says so a second time because a generic "repair the awards"
 * job that minted one would be handing out a credential nobody earned.
 *
 * It never writes a row itself. Everything goes through `awardOnPromotion`,
 * the same writer a live promotion uses, so each award carries real frozen
 * evidence, a printed reference and a verification token. An INSERT here
 * would produce rows that look like credentials and verify as nothing.
 *
 * It never invents a person. An award carries the name of whoever the
 * promotion rode on. Where the trail names nobody and no reviewer can be
 * found, the tier is reported as blocked and left alone.
 */

/** The audit actions that record a candidate moving forward. */
const MOVE_ACTIONS = ['pipeline.advanced', 'pipeline.auto_advanced', 'pipeline.finalized'] as const;

/** The one action allowed to carry a candidate past stages nobody judged. */
const FINALISATION = 'pipeline.finalized';

export interface BackfillMove {
  readonly action: string;
  readonly from: string;
  readonly to: string;
  readonly at: Date;
  readonly actorId: string | null;
}

/** Who an award will be struck in the name of, and on what grounds. */
export interface AwardCredit {
  readonly userId: string;
  readonly name: string;
  readonly because: 'moved_them' | 'reviewed_the_interview';
}

export interface StageStep {
  readonly from: string;
  readonly to: string;
}

export interface MissingAward {
  readonly tenantId: string;
  readonly pipelineId: string;
  readonly candidateId: string;
  readonly candidateName: string;
  readonly roleId: string;
  readonly roleTitle: string;
  readonly tier: AwardTier;
  /** When the move that earned it happened, as the trail recorded it. */
  readonly earnedOn: Date;
  readonly move: BackfillMove;
  /**
   * The step the tier is earned BY, which is what the writer is given.
   *
   * Not the same as the move for an advance that skipped stages: a recorded
   * Bronze → Gold earns Silver through its `silver → gold` step, and handing
   * the writer `bronze → gold` would replay the product rule that earns
   * nothing — the report would promise a credential that `--apply` never
   * minted.
   */
  readonly step: StageStep;
  readonly credit: AwardCredit | null;
  /** Why this one cannot be struck. Null when it can. */
  readonly blocked: string | null;
}

export interface BackfillReport {
  readonly pipelinesRead: number;
  readonly pipelinesWithoutTrail: number;
  readonly missing: readonly MissingAward[];
  /** Struck only on a run that was asked to write; empty on a dry run. */
  readonly struck: readonly { readonly candidateId: string; readonly tier: AwardTier; readonly reference: string }[];
}

interface StageEvent {
  readonly stage?: unknown;
}

function stageOf(json: string, id: string): string | null {
  const parsed = parseJsonOptional<StageEvent>(json, {}, { model: 'AuditEvent', id, field: 'stage' });
  return typeof parsed.stage === 'string' && parsed.stage.length > 0 ? parsed.stage : null;
}

/**
 * The one-stage steps a non-finalising move is replayed as.
 *
 * A move recorded as Bronze → Gold happened in one write, but it is two
 * promotions' worth of progress and the candidate sat, however briefly, at
 * every stage between. Replaying it as the product would perform it today —
 * `advancePipeline` moves to the next stage and nothing else — is what
 * recovers the Silver it passed through.
 *
 * Backwards or unrecognised endpoints yield nothing rather than guessing.
 */
export function stepsOf(stages: readonly PipelineStage[], from: string, to: string): StageStep[] {
  const fromIndex = stages.findIndex((stage) => stage.key === from);
  const toIndex = stages.findIndex((stage) => stage.key === to);
  if (fromIndex < 0 || toIndex <= fromIndex) return [];
  const steps: StageStep[] = [];
  for (let i = fromIndex; i < toIndex; i++) steps.push({ from: stages[i].key, to: stages[i + 1].key });
  return steps;
}

export interface EarnedTier {
  readonly tier: AwardTier;
  /** The step that earned it, which is what the writer must be handed. */
  readonly step: StageStep;
}

/**
 * The tiers a recorded move earned, under the rule its action carries, each
 * paired with the step that earned it.
 *
 * The pairing is not bookkeeping. `awardOnPromotion` re-derives the tiers from
 * the from/to it is given, so handing it the whole of a Bronze → Gold move
 * would strike nothing at all — the report would name a Silver that `--apply`
 * never minted, which is a worse failure than the missing award, because an
 * operator would believe it had been repaired.
 */
export function tiersEarnedBy(stages: readonly PipelineStage[], move: BackfillMove): EarnedTier[] {
  const steps = move.action === FINALISATION
    ? [{ from: move.from, to: move.to }]
    : stepsOf(stages, move.from, move.to);
  return steps.flatMap((step) => awardsForPromotion(stages, step.from, step.to)
    // Said twice on purpose. `awardsForPromotion` cannot return Bronze, and if
    // that ever changes this job must not be the thing that discovers it by
    // issuing one.
    .filter((tier) => tier !== 'bronze')
    .map((tier) => ({ tier, step })));
}

async function movesOf(pipelineId: string, tenantId: string): Promise<BackfillMove[]> {
  const events = await prisma.auditEvent.findMany({
    where: { tenantId, entityType: 'CandidatePipeline', entityId: pipelineId, action: { in: [...MOVE_ACTIONS] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, action: true, actorId: true, actorType: true, beforeJson: true, afterJson: true, createdAt: true },
  });
  const moves: BackfillMove[] = [];
  for (const event of events) {
    const from = stageOf(event.beforeJson, event.id);
    const to = stageOf(event.afterJson, event.id);
    if (!from || !to) continue;
    moves.push({
      action: event.action,
      from,
      to,
      at: event.createdAt,
      actorId: event.actorType === 'user' && event.actorId !== 'system' ? event.actorId : null,
    });
  }
  return moves;
}

/**
 * The person an automatic move's award belongs to: whoever read the AI
 * interview.
 *
 * An automatic move names nobody, and a Silver has to carry a name. The
 * honest one is the reviewer — the Silver evidence already says "Assessed by
 * <them>, subject-matter expert", read from the review row itself, so
 * crediting them here makes the signature and the award agree instead of
 * putting an operator's name under a reading they did not make.
 *
 * Null where nobody reviewed it. That candidate's Silver stays unstruck and
 * is reported as such: a credential minted for an interview no person opened
 * is the thing the human-review gate exists to prevent.
 *
 * Bounded by the move's own instant, and that bound is the whole of the
 * correctness here. The latest review of the candidate is not the review the
 * move rode on: a candidate with a retake read by somebody else last week
 * would have that person's name put under "assessed by" on a certificate
 * about an interview they never opened. Only a review that had already
 * completed when the candidate was carried out of the round can be the one
 * that carried them, so the newest review AT OR BEFORE the move is taken, and
 * where there is none the tier is blocked rather than guessed at.
 */
async function reviewerOf(o: { tenantId: string; candidateId: string; roleId: string; by: Date }): Promise<AwardCredit | null> {
  const review = await prisma.humanReview.findFirst({
    where: {
      status: 'COMPLETED',
      // The review has to have been finished by the time of the move. A
      // COMPLETED row with no `completedAt` cannot prove that, and an award is
      // not the place to assume it.
      completedAt: { not: null, lte: o.by },
      // Standing AT THE MOVE, which is not the same question as standing now.
      //
      // `activeForAssessmentId` and `supersededAt` are both current-state
      // fields, and asking them as they read today gets this wrong in both
      // directions. A review that was the standing one when the candidate was
      // promoted and was replaced by a retake last week reads as superseded
      // now — dropping it does not merely lose the credit, it falls through to
      // an OLDER review and puts the wrong person under "assessed by". So the
      // supersession is asked with a date: it counts if it was still standing
      // at the move.
      //
      // The first clause is what keeps a blind verdict out. A blind verdict is
      // COMPLETED and never superseded, and it is not the review the promise
      // is about; it is the only row that is neither active nor superseded, so
      // failing both clauses is exactly what excludes it.
      OR: [{ activeForAssessmentId: { not: null } }, { supersededAt: { gt: o.by } }],
      assessment: { session: { tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId } },
    },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    select: { reviewer: { select: { id: true, name: true } } },
  });
  return review ? { userId: review.reviewer.id, name: review.reviewer.name, because: 'reviewed_the_interview' } : null;
}

async function moverOf(tenantId: string, actorId: string): Promise<AwardCredit | null> {
  const user = await prisma.user.findFirst({ where: { id: actorId, tenantId }, select: { id: true, name: true } });
  return user ? { userId: user.id, name: user.name, because: 'moved_them' } : null;
}

export interface BackfillOptions {
  /** Default. Nothing is written; the report says what would be. */
  readonly dryRun: boolean;
  /** One organisation, or every one when omitted. */
  readonly tenantId?: string;
}

/**
 * Find every tier a recorded move earned and the candidate does not hold.
 *
 * Reads only, whatever the options say. Writing is `strikeMissingAwards`,
 * which takes this report and is the only function here that can change
 * anything.
 */
export async function findMissingAwards(o: { readonly tenantId?: string } = {}): Promise<BackfillReport> {
  const pipelines = await prisma.candidatePipeline.findMany({
    where: o.tenantId ? { tenantId: o.tenantId } : {},
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, tenantId: true, candidateId: true, roleId: true, stagesJson: true,
      candidate: { select: { fullName: true } },
      role: { select: { title: true } },
    },
  });

  const missing: MissingAward[] = [];
  let withoutTrail = 0;

  for (const pipeline of pipelines) {
    const moves = await movesOf(pipeline.id, pipeline.tenantId);
    if (moves.length === 0) {
      withoutTrail += 1;
      continue;
    }
    // Lenient, unlike the decision paths: a plan this job cannot read is a
    // reason to report a pipeline untouched, never to abort the sweep over
    // every other organisation's candidates.
    const stages = parseStages(pipeline.stagesJson);

    const held = new Set((await prisma.candidateAward.findMany({
      where: { candidateId: pipeline.candidateId, roleId: pipeline.roleId }, select: { tier: true },
    })).map((a) => a.tier));

    // Earliest move first, so a tier earned twice in the history is reported
    // against the move that first earned it — which is the date the
    // credential is actually about.
    const owed = new Map<AwardTier, { move: BackfillMove; step: StageStep }>();
    for (const move of moves) {
      for (const { tier, step } of tiersEarnedBy(stages, move)) {
        if (held.has(tier) || owed.has(tier)) continue;
        owed.set(tier, { move, step });
      }
    }

    for (const tier of AWARD_TIERS) {
      const entry = owed.get(tier);
      if (!entry) continue;
      const { move, step } = entry;
      const credit = move.actorId
        ? await moverOf(pipeline.tenantId, move.actorId)
        : await reviewerOf({
          tenantId: pipeline.tenantId, candidateId: pipeline.candidateId, roleId: pipeline.roleId, by: move.at,
        });
      missing.push({
        tenantId: pipeline.tenantId,
        pipelineId: pipeline.id,
        candidateId: pipeline.candidateId,
        candidateName: pipeline.candidate.fullName,
        roleId: pipeline.roleId,
        roleTitle: pipeline.role.title,
        tier,
        earnedOn: move.at,
        move,
        step,
        credit,
        blocked: credit
          ? null
          : move.actorId
            ? 'the person who made this move is no longer a user of this organisation'
            : 'an automatic move, and no person had reviewed this candidate’s AI interview by then',
      });
    }
  }

  return { pipelinesRead: pipelines.length, pipelinesWithoutTrail: withoutTrail, missing, struck: [] };
}

/**
 * Strike the awards a report found, through the writer a live promotion uses.
 *
 * Idempotent twice over: `strike` refuses a tier the candidate already holds,
 * and the unique (candidate, role, tier) key refuses it again at the database
 * if two runs somehow overlap. Running this a second time strikes nothing and
 * reports nothing struck.
 *
 * One transaction per award rather than one for the whole sweep: a tier that
 * cannot be written — an erased candidate, a deleted role — must not take
 * every other candidate's credential down with it.
 *
 * The writer is handed the STEP that earned the tier and the date the move
 * happened. The step, because `awardOnPromotion` re-derives the tiers from
 * what it is given and a whole Bronze → Gold move earns nothing. The date,
 * because a credential is read for years by people who cannot check the audit
 * trail behind it, and one stamped with the day an operator ran a repair job
 * contradicts that trail in the one field a reader can see.
 */
export async function strikeMissingAwards(report: BackfillReport): Promise<BackfillReport> {
  const struck: { candidateId: string; tier: AwardTier; reference: string }[] = [];
  for (const owed of report.missing) {
    if (!owed.credit) continue;
    const pipeline = await prisma.candidatePipeline.findUnique({ where: { id: owed.pipelineId }, select: { stagesJson: true } });
    if (!pipeline) continue;
    const stages = parseStages(pipeline.stagesJson);
    let awards: StruckAward[] = [];
    try {
      awards = await prisma.$transaction((tx) => awardOnPromotion(tx, {
        tenantId: owed.tenantId, candidateId: owed.candidateId, roleId: owed.roleId,
        stages, fromStageKey: owed.step.from, toStageKey: owed.step.to,
        actorId: owed.credit!.userId, awardedAt: owed.earnedOn,
      }));
    } catch (err) {
      // Another run, or a live promotion, struck it first. That is the
      // idempotency working, not a failure.
      if (!isAwardConflict(err)) throw err;
      continue;
    }
    // After the commit, so the trail can never claim a badge that rolled back.
    await auditAwards({ tenantId: owed.tenantId, actorId: owed.credit.userId, candidateId: owed.candidateId, awards });
    for (const award of awards) struck.push({ candidateId: owed.candidateId, tier: award.tier, reference: award.reference });
  }
  return { ...report, struck };
}

/** One line per owed credential, in the words an operator has to decide from. */
export function describeMissing(owed: MissingAward): string {
  const who = owed.credit
    ? `${owed.credit.name} (${owed.credit.because === 'moved_them' ? 'moved them' : 'reviewed the interview'})`
    : 'NOBODY';
  const suffix = owed.blocked ? ` — BLOCKED: ${owed.blocked}` : '';
  // The step is named beside the move, because for an advance that skipped a
  // stage they differ and the step is the one the certificate is about.
  const via = owed.step.from === owed.move.from && owed.step.to === owed.move.to
    ? ''
    : ` (via ${owed.step.from} → ${owed.step.to})`;
  return [
    `${TIER_LABELS[owed.tier]} for ${owed.candidateName} on ${owed.roleTitle}`,
    `earned ${owed.earnedOn.toISOString()} by ${owed.move.action} ${owed.move.from} → ${owed.move.to}${via}`,
    `would be struck in the name of ${who}${suffix}`,
  ].join('; ');
}
