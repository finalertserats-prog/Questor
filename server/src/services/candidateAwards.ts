import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { parseJsonOptional } from '../db.js';
import { logAudit } from './audit.js';
import { logger } from '../logger.js';
import type { PipelineStage } from '../domain/pipelineStages.js';
import type { FitScore, AssessmentResult } from '../domain/types.js';
import { comparableFitScore } from '../domain/fitVocabulary.js';
import { LATEST_PROFILE } from './resumeProfile.js';
import {
  AWARD_TIERS, awardsForPromotion, formatReference, referenceBlocks,
  serialiseEvidence, TIER_LABELS, type AwardFacts, type AwardHumanRound, type AwardTier,
} from '../domain/candidateAwards.js';

/**
 * The award engine: striking a tier onto a candidate's journey.
 *
 * Every entry point here takes a transaction client and does its writing
 * inside the caller's transaction, beside the move that earned the award. That
 * is the whole point of the module. A Gold → Diamond promotion earns two
 * badges, and a run that moved the candidate but wrote one badge, or wrote the
 * badges but lost the move, leaves a journey that contradicts itself with
 * nothing to say which half is right. Both or neither.
 *
 * Auditing is deliberately NOT done here: `logAudit` writes on the shared
 * client, so an audit written inside the transaction would survive a rollback
 * and claim an award that never landed. Callers pass what comes back to
 * `auditAwards` once their transaction has committed.
 */

export interface StruckAward {
  readonly id: string;
  readonly tier: AwardTier;
  readonly reference: string;
}

interface AwardTarget {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly roleId: string;
}

/**
 * The public verification token.
 *
 * Independent randomness, never a function of the printed reference. The
 * reference is on a certificate that may be handed to anyone; `questor.app/v/…`
 * is public and unauthenticated. Deriving one from the other would mean that
 * reading a single certificate — or guessing at the reference format, which is
 * four characters and four digits — opens the verification record of any other
 * award. 32 bytes, so guessing is not a strategy.
 */
function mintVerifyToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Facts, read once, frozen onto the award
// ---------------------------------------------------------------------------

function competencyCounts(fitJson: string | undefined): { evidenced: number; total: number } {
  const fit = parseJsonOptional<Partial<FitScore>>(fitJson ?? '', {}, { model: 'CandidateProfileVersion', id: '', field: 'fitScoreJson' });
  const read = fit.competencies ?? [];
  if (read.length > 0) {
    return { evidenced: read.filter((c) => c.strength !== 'not_evidenced').length, total: read.length };
  }
  // Rows written before the evidence-backed scorer carry components and a list
  // of what the CV was silent on, and nothing richer. Counting those is a truer
  // reading than reporting zero of zero.
  const total = fit.components?.length ?? 0;
  return { evidenced: Math.max(total - (fit.missing?.length ?? 0), 0), total };
}

function approvedFit(fitJson: string): FitScore | null {
  const fit = parseJsonOptional<Partial<FitScore>>(fitJson, {}, { model: 'CandidateProfileVersion', id: '', field: 'fitScoreJson' });
  // The shared rule first, so it lives in one place: a provisional reading —
  // one measured against a scorecard nobody approved — is not a number anything
  // may rank, filter or compare on (domain/fitVocabulary.ts).
  if (comparableFitScore(fit) === null) return null;
  // Then stricter than a ranking needs to be. A certificate is struck once and
  // read for years, and a Bronze minted off an unapproved reading is
  // indistinguishable from a real one afterwards. So the stamp must say
  // "approved" — a fit that cannot say what it was measured against is not
  // claimed as approved. Rows written before the stamp existed land here, and
  // not striking a badge for them is the safe direction.
  return fit.scorecardStatus === 'approved' ? (fit as FitScore) : null;
}

/**
 * A tier the candidate already holds, lost at the database rather than at the
 * read above.
 *
 * The read is normally enough: the stage move an award rides on is a
 * conditional update, so two promotions cannot both reach the insert. This is
 * the deliberate answer for the case where one somehow does — a retry, a
 * double-click that beats the move's own guard — so that whoever pressed the
 * button is told the pipeline moved under them instead of being shown a 500.
 *
 * Narrowed to the tier key on purpose. A collision on `reference` or
 * `verifyToken` is a different animal — a one-in-billions draw, not a race —
 * and answering it with "the pipeline moved under you" would send someone off
 * to reload a pipeline that is exactly where they left it. Those stay loud.
 */
export function isAwardConflict(err: unknown): boolean {
  const fault = err as { code?: string; meta?: { target?: unknown } } | null;
  if (fault?.code !== 'P2002') return false;
  // Postgres reports an array of column names, SQLite a joined string; both
  // name the columns, and only the tier key mentions `tier`.
  return JSON.stringify(fault.meta?.target ?? '').includes('tier');
}

/**
 * Which reads a tier's five rows actually need.
 *
 * Deliberate, because this runs inside somebody else's write transaction —
 * a resume upload, a stage move — and every query here is time that
 * transaction holds its locks for. Gathering everything for every tier put
 * eight reads inside the resume path, which is the slowest transaction in the
 * server already and the one that times out first.
 *
 * The candidate and the role are NOT in this table, and not read here at all.
 * Every tier needs them, and `readIdentity` takes them once for the whole
 * promotion before the moment is stamped — see there for why the order
 * matters.
 */
const FACTS_NEEDED: Readonly<Record<AwardTier, { profile: boolean; interview: boolean; rounds: boolean }>> = {
  bronze: { profile: true, interview: false, rounds: false },
  silver: { profile: true, interview: true, rounds: false },
  gold: { profile: false, interview: false, rounds: true },
  diamond: { profile: false, interview: false, rounds: false },
};

/**
 * Who the award is about and what role it is for, as Questor holds them.
 *
 * Read BEFORE `awardedAt` is stamped, and that order is the point rather than
 * a detail. Stamping first and reading afterwards let a rename that landed in
 * between put a title onto the certificate that was not yet true at the moment
 * the certificate says it was struck. Reading first inverts that: the award can
 * only ever name something Questor had already read, never something that
 * changed after the fact.
 *
 * It does not make the window zero — a rename committing between this read and
 * the stamp a moment later still leaves the two microseconds apart — and
 * closing it completely would mean locking the role row inside the resume
 * upload, which is the slowest transaction in the server and the one that
 * times out first. The claim the document actually makes is that this is the
 * name and title Questor held when it struck the award, and this ordering is
 * what makes that sentence true.
 *
 * Read once for the whole promotion, not once per tier: a Gold → Diamond move
 * strikes two awards and they are about the same person and the same role, so
 * two reads could only ever disagree with each other.
 *
 * Tenant-filtered, like every read on the way to a document about a named
 * person. Both ids reached here through a tenant-scoped read already, so this
 * changes nothing today; it means a certificate can never come to carry
 * another organisation's name because a caller was refactored.
 */
interface AwardIdentity {
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly candidateCreatedAt: Date | null;
}

async function readIdentity(tx: Prisma.TransactionClient, o: AwardTarget): Promise<AwardIdentity> {
  const candidate = await tx.candidate.findFirst({
    where: { id: o.candidateId, tenantId: o.tenantId }, select: { createdAt: true, fullName: true },
  });
  const role = await tx.role.findFirst({ where: { id: o.roleId, tenantId: o.tenantId }, select: { title: true } });
  return {
    candidateName: candidate?.fullName ?? '',
    roleTitle: role?.title ?? '',
    candidateCreatedAt: candidate?.createdAt ?? null,
  };
}

async function gatherFacts(
  tx: Prisma.TransactionClient,
  o: AwardTarget & { readonly tier: AwardTier; readonly awardedAt: Date; readonly identity: AwardIdentity; readonly stageKeyLeft: string; readonly promotedTo: string; readonly promotedByName: string; readonly recordedByName: string; readonly priorTier: AwardTier | null },
): Promise<AwardFacts> {
  const needs = FACTS_NEEDED[o.tier];

  const profileRow = needs.profile
    ? await tx.candidateProfileVersion.findFirst({
      where: { candidateId: o.candidateId }, orderBy: LATEST_PROFILE, select: { createdAt: true, fitScoreJson: true },
    })
    : null;
  const fit = profileRow ? approvedFit(profileRow.fitScoreJson) : null;
  const counts = competencyCounts(profileRow?.fitScoreJson);

  const session = needs.interview
    ? await tx.interviewSession.findFirst({
      where: { candidateId: o.candidateId, roleId: o.roleId, completedAt: { not: null } },
      orderBy: { completedAt: 'desc' },
      select: { id: true, completedAt: true, startedAt: true, durationMinutes: true },
    })
    : null;
  const assessment = session
    ? await tx.assessmentVersion.findFirst({ where: { sessionId: session.id }, orderBy: { version: 'desc' }, select: { id: true, resultJson: true } })
    : null;
  const result = assessment
    ? parseJsonOptional<Partial<AssessmentResult>>(assessment.resultJson, {}, { model: 'AssessmentVersion', id: assessment.id, field: 'resultJson' })
    : null;
  const graded = result?.competencies ?? [];

  const review = assessment
    ? await tx.humanReview.findFirst({
      where: { assessmentId: assessment.id, status: 'COMPLETED' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, reviewer: { select: { name: true } } },
    })
    : null;

  const rounds = needs.rounds
    ? await tx.interviewRound.findMany({
      where: { pipeline: { candidateId: o.candidateId, roleId: o.roleId }, stageKey: o.stageKeyLeft, status: 'COMPLETED', conductedBy: 'HUMAN' },
      orderBy: { completedAt: 'asc' },
      select: { id: true, completedAt: true, durationMinutes: true, interviewersJson: true },
    })
    : [];

  const prior = o.priorTier
    ? await tx.candidateAward.findFirst({ where: { candidateId: o.candidateId, roleId: o.roleId, tier: o.priorTier }, select: { awardedAt: true } })
    : null;

  return {
    awardedAt: o.awardedAt,
    candidateName: o.identity.candidateName,
    roleTitle: o.identity.roleTitle,
    candidateCreatedAt: o.identity.candidateCreatedAt,
    profile: profileRow && fit
      ? {
          readAt: profileRow.createdAt,
          scorecardVersion: fit.scorecardVersion ?? null,
          competenciesEvidenced: counts.evidenced,
          competenciesTotal: counts.total,
        }
      : null,
    aiInterview: session?.completedAt
      ? {
          completedAt: session.completedAt,
          minutes: session.startedAt ? Math.round((session.completedAt.getTime() - session.startedAt.getTime()) / 60_000) : null,
          competencies: graded.length,
          // "Every rating carries a verbatim quote" is a claim about all of
          // them, so an assessment with a single unquoted rating must not make
          // it. An assessment with no ratings at all cannot make it either.
          quotedEvidence: graded.length > 0 && graded.every((c) => (c.evidence ?? []).some((e) => (e?.quote ?? '').trim().length > 0)),
        }
      : null,
    humanReview: review?.reviewer?.name ? { at: review.createdAt, reviewerName: review.reviewer.name } : null,
    humanRounds: rounds
      .filter((round): round is typeof round & { completedAt: Date } => round.completedAt !== null)
      .map((round): AwardHumanRound => ({
        completedAt: round.completedAt,
        minutes: round.durationMinutes ?? null,
        interviewers: parseJsonOptional<string[]>(round.interviewersJson, [], { model: 'InterviewRound', id: round.id, field: 'interviewersJson' }),
      })),
    priorAwardAt: prior?.awardedAt ?? null,
    promotedTo: o.promotedTo,
    promotedByName: o.promotedByName,
    recordedByName: o.recordedByName,
  };
}

// ---------------------------------------------------------------------------
// Striking
// ---------------------------------------------------------------------------

/**
 * How many reference collisions to ride out before giving up.
 *
 * Four characters from a 31-letter alphabet and four digits is about 9.2
 * billion per tier, so five draws colliding means something is wrong rather
 * than unlucky. Giving up throws, which rolls the caller's transaction back:
 * the move is refused and nothing half-written survives, which is the right
 * failure for a badge that could not be given a reference.
 */
const REFERENCE_ATTEMPTS = 5;

async function strike(
  tx: Prisma.TransactionClient,
  o: AwardTarget & { readonly tier: AwardTier; readonly awardedAt: Date; readonly awardedByUserId: string | null; readonly facts: AwardFacts },
): Promise<StruckAward | null> {
  // Read, then write, inside the caller's transaction. Concurrent promotions
  // cannot both reach here — the stage move each of them is part of is a
  // conditional update and only one wins it — so this read is not the race it
  // would be on its own, and on Postgres a failed insert would poison the whole
  // transaction and take the move down with it.
  const already = await tx.candidateAward.findFirst({
    where: { candidateId: o.candidateId, roleId: o.roleId, tier: o.tier }, select: { id: true },
  });
  // A tier already struck is never re-struck. The first certificate stated what
  // was true when it was struck and that is what it goes on saying; a second CV
  // upload or a repeated promotion must not rewrite it.
  if (already) return null;

  const evidenceJson = serialiseEvidence(o.tier, o.facts);
  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt++) {
    const { block, digits } = referenceBlocks();
    const reference = formatReference(o.tier, block, digits);
    const taken = await tx.candidateAward.findFirst({ where: { reference }, select: { id: true } });
    if (taken) continue;
    const created = await tx.candidateAward.create({
      data: {
        tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId, tier: o.tier,
        awardedAt: o.awardedAt, awardedByUserId: o.awardedByUserId,
        reference, verifyToken: mintVerifyToken(), evidenceJson,
      },
      select: { id: true },
    });
    return { id: created.id, tier: o.tier, reference };
  }
  throw new Error(`Could not mint a free reference for a ${o.tier} award after ${REFERENCE_ATTEMPTS} attempts`);
}

export interface PromotionAwardInput extends AwardTarget {
  readonly stages: readonly PipelineStage[];
  readonly fromStageKey: string;
  readonly toStageKey: string;
  /** The person who moved them. Their id is what lands on every tier this move earns. */
  readonly actorId: string;
}

/**
 * Strike whatever a single promotion earned, in the caller's transaction.
 *
 * A Gold → Diamond move returns two awards. They are written one after the
 * other in the same transaction, so a failure on the second takes the first —
 * and the move — with it.
 */
export async function awardOnPromotion(tx: Prisma.TransactionClient, o: PromotionAwardInput): Promise<StruckAward[]> {
  const tiers = awardsForPromotion(o.stages, o.fromStageKey, o.toStageKey);
  if (tiers.length === 0) return [];

  const actor = await tx.user.findFirst({ where: { id: o.actorId, tenantId: o.tenantId }, select: { name: true } });
  const identity = await readIdentity(tx, o);
  // Stamped only now that everything the certificate names has been read, so
  // the award cannot claim a title that became true after this instant.
  const awardedAt = new Date();
  const toLabel = o.stages.find((stage) => stage.key === o.toStageKey)?.label ?? o.toStageKey;

  const struck: StruckAward[] = [];
  for (const tier of tiers) {
    const facts = await gatherFacts(tx, {
      tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId,
      tier, awardedAt, identity, stageKeyLeft: tier === 'diamond' ? o.fromStageKey : tier,
      promotedTo: toLabel, promotedByName: actor?.name ?? '',
      // The same person on a promotion: they moved the candidate, and moving
      // them is the act this award records.
      recordedByName: actor?.name ?? '',
      priorTier: priorTierOf(tier),
    });
    const award = await strike(tx, {
      tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId,
      tier, awardedAt, awardedByUserId: o.actorId, facts,
    });
    if (award) struck.push(award);
  }
  return struck;
}

/**
 * The tier below, for the one evidence row that refers back to it ("Silver
 * assessment completed and progressed"). Only Gold and Diamond carry such a
 * row, so only they pay for the read.
 */
function priorTierOf(tier: AwardTier): AwardTier | null {
  if (tier === 'gold') return 'silver';
  if (tier === 'diamond') return 'gold';
  return null;
}

export interface BronzeAwardInput extends AwardTarget {
  /** The fit just written, as JSON, so the stamp is read from what was stored rather than from the role. */
  readonly fitScoreJson: string;
  /**
   * Who put the CV into Questor, for the certificate's right-hand signature.
   *
   * Not who assessed it — `awardedByUserId` stays null on a Bronze precisely
   * because nobody did. This is the other slot, and it names a real act: a
   * person uploaded this CV, and the line under their name says "recorded by",
   * which claims nothing about the reading.
   */
  readonly recordedByUserId: string;
}

/**
 * Bronze: the CV read against an APPROVED scorecard, and a fit computed.
 *
 * The only award no person makes, so `awardedByUserId` stays null and the
 * certificate says "no human review" because of it. A reading measured against
 * an unapproved draft strikes nothing: the badge would claim an assessment
 * against a scorecard nobody had checked, and the fit itself already refuses to
 * stand in for an approved one anywhere a decision is later justified from.
 */
export async function awardBronze(tx: Prisma.TransactionClient, o: BronzeAwardInput): Promise<StruckAward[]> {
  // Read before the facts, and only once the fit has decided there is an award
  // to strike at all: an unapproved reading leaves this transaction without
  // having touched the user table.
  if (!approvedFit(o.fitScoreJson)) return [];
  const recorder = await tx.user.findFirst({ where: { id: o.recordedByUserId, tenantId: o.tenantId }, select: { name: true } });
  const identity = await readIdentity(tx, o);
  // Read first, stamped second, for the reason set out on `readIdentity`.
  const awardedAt = new Date();
  const facts = await gatherFacts(tx, {
    tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId,
    tier: 'bronze', awardedAt, identity, stageKeyLeft: 'bronze', promotedTo: '', promotedByName: '',
    recordedByName: recorder?.name ?? '', priorTier: null,
  });
  const award = await strike(tx, {
    tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId,
    tier: 'bronze', awardedAt, awardedByUserId: null, facts,
  });
  return award ? [award] : [];
}

/**
 * Record the awards a committed transaction struck.
 *
 * Called after the commit, never inside it: an audit written inside would
 * outlive a rollback and claim a badge nobody holds. The reference goes in the
 * trail because it is what a person holding the certificate will quote; the
 * verification token never does, because the trail is readable by anyone who
 * may read the audit log and the token is the key to a public page.
 */
export async function auditAwards(o: { readonly tenantId: string; readonly actorId: string | null; readonly candidateId: string; readonly awards: readonly StruckAward[] }): Promise<void> {
  for (const award of o.awards) {
    await logAudit({
      tenantId: o.tenantId,
      actorType: o.actorId ? 'user' : 'system',
      ...(o.actorId ? { actorId: o.actorId } : {}),
      action: 'award.struck', entityType: 'CandidateAward', entityId: award.id,
      after: { candidateId: o.candidateId, tier: award.tier, reference: award.reference, humanAssessed: o.actorId !== null },
    });
  }
}

/**
 * The same, for a caller whose own write must not fail because an award could
 * not be recorded in the trail. The award itself has committed by then.
 */
export function noteAwards(o: { readonly tenantId: string; readonly actorId: string | null; readonly candidateId: string; readonly awards: readonly StruckAward[] }): Promise<void> {
  return auditAwards(o).catch((err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err), candidateId: o.candidateId }, 'Awards were struck but could not be recorded in the audit trail');
  });
}

export { AWARD_TIERS, TIER_LABELS };
