import { Router } from 'express';
import { prisma, parseJsonOptional } from '../db.js';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { assertCanAccessCandidate } from '../services/access.js';
import { DEFAULT_STAGES, parseStagesStrict } from '../domain/pipelineStages.js';
import {
  awardHeadline, isAwardTier, journeyTiers, tierHasCertificate, unearnedReason,
  TIER_LABELS, type AwardTier, type StoredEvidence,
} from '../domain/candidateAwards.js';

/**
 * The candidate's journey, one row per tier.
 *
 * A row is earned or it is not. An earned row carries the badge, what
 * happened, the date and the export paths; an unearned one carries the reason
 * it is not there yet and NOTHING else — no reference, no evidence, no export.
 * That asymmetry is the feature: a candidate whose Silver interview is finished
 * but who has not been progressed has no Silver badge, and a response that
 * shipped a reference "for later" is how a badge ends up rendered early.
 */
export const candidateAwardsRouter = Router();
candidateAwardsRouter.use(authenticate);

/** The agreed export paths (docs/credentials-contract.md §5). Served by the certificate lane. */
function exportPaths(candidateId: string, tier: AwardTier) {
  const base = `/api/candidates/${candidateId}/awards/${tier}`;
  return {
    badgeSvg: `${base}/badge.svg`,
    badgePng: `${base}/badge.png`,
    // Diamond records what an employer decided, which is theirs to announce.
    certificatePdf: tierHasCertificate(tier) ? `${base}/certificate.pdf` : null,
  };
}

candidateAwardsRouter.get('/:id/awards', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const candidate = await assertCanAccessCandidate(req.auth!, req.params.id);
  const tenantId = req.auth!.tenantId;

  const pipeline = await prisma.candidatePipeline.findFirst({
    where: { candidateId: candidate.id, tenantId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, roleId: true, stagesJson: true, currentStageKey: true },
  });
  // A candidate with no pipeline is at the start of one: the stage plan is the
  // default, and they are at its first stage, so nothing has been earned yet.
  const stages = pipeline
    ? parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' })
    : DEFAULT_STAGES.map((stage) => ({ ...stage }));
  const currentStageKey = pipeline?.currentStageKey ?? stages[0].key;

  // Scoped to the role this journey is about, not to the person. An award is
  // per (candidate, role): a Gold earned on one role says nothing about
  // another, and collapsing them by tier would put one role's badge on
  // another's journey. The role comes from the pipeline being shown, and a
  // candidate with no pipeline yet has earned nothing to show.
  const stored = pipeline ? await prisma.candidateAward.findMany({
    where: { candidateId: candidate.id, tenantId, roleId: pipeline.roleId },
    orderBy: { awardedAt: 'asc' },
    // Explicitly never the verification token: it is the key to a public page,
    // and this row travels to the candidate's detail screen. Listing the
    // columns means a field added to the model later has to be let out on
    // purpose rather than by default.
    select: {
      id: true, tier: true, awardedAt: true, awardedByUserId: true,
      reference: true, evidenceJson: true, sentToCandidateAt: true,
    },
  }) : [];
  const byTier = new Map(stored.filter((row) => isAwardTier(row.tier)).map((row) => [row.tier as AwardTier, row]));

  const awardedByIds = stored.map((row) => row.awardedByUserId).filter((id): id is string => id !== null);
  const users = awardedByIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: awardedByIds }, tenantId }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((user) => [user.id, user.name]));

  const rows = journeyTiers(stages, currentStageKey, [...byTier.keys()]).map((tier) => {
    const award = byTier.get(tier);
    if (!award) {
      return {
        tier, label: TIER_LABELS[tier], earned: false as const,
        reason: unearnedReason(stages, tier),
      };
    }
    const evidence = parseJsonOptional<Partial<StoredEvidence>>(
      award.evidenceJson, {}, { model: 'CandidateAward', id: award.id, field: 'evidenceJson' },
    ).rows ?? [];
    return {
      tier, label: TIER_LABELS[tier], earned: true as const,
      awardedAt: award.awardedAt,
      reference: award.reference,
      // Bronze has no name on it because no person assessed it, and the row
      // says so rather than leaving a blank a reader fills in themselves.
      awardedBy: award.awardedByUserId ? nameOf.get(award.awardedByUserId) ?? null : null,
      humanAssessed: award.awardedByUserId !== null,
      headline: awardHeadline(tier, evidence),
      evidence,
      hasCertificate: tierHasCertificate(tier),
      exports: exportPaths(candidate.id, tier),
      // Sending a certificate to the candidate is an admin action and never
      // happens from this row; the date is here so the row can say it has.
      sentToCandidateAt: award.sentToCandidateAt,
    };
  });

  res.json({ awards: rows });
}));
