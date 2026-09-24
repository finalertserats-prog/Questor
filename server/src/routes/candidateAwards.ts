import { Router } from 'express';
<<<<<<< HEAD
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
=======
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logAudit } from '../services/audit.js';
import { getEmail } from '../providers/email/index.js';
import { logger } from '../logger.js';
import {
  assertCanAccessAward,
  badgeFilename,
  certificateFilename,
  readTier,
  verifyDisplayUrl,
} from '../services/candidateAwards.js';
import { hasCertificate, parseAwardEvidence, NO_DIAMOND_CERTIFICATE, AwardEvidenceError } from '../services/awardEvidence.js';
import { certificatePdf, issuedOn } from '../services/certificatePdf.js';
import { badgeSvg } from '../services/badgeSvg.js';
import { badgePng } from '../services/badgePng.js';
import { MAX_BADGE_PX, MIN_BADGE_PX } from '../services/rasterPng.js';

/**
 * Exporting a credential: the certificate as a PDF, the badge as a PNG or an
 * SVG, and the one admin action that sends a certificate to the candidate.
 *
 * Its own router rather than more of `candidates.ts`, which is already long.
 * Mounted on the same `/api/candidates` prefix, so the paths read as what they
 * are: `/api/candidates/:id/awards/:tier/certificate.pdf`.
 *
 * Every route reads from the award's frozen `evidenceJson` and never from the
 * live candidate, role or user rows. A certificate states what was true when
 * it was struck.
 */


/**
 * Rendering costs far more than reading.
 *
 * A certificate lays out a page of vector text and strikes a seal into it; a
 * PNG badge is rasterised in this process, on the event loop, and at the top
 * of its size range that is a megapixel of scanline work. Per user rather than
 * per address — an office shares one IP — and generous enough that nobody
 * exporting a real shortlist will ever see it.
 */
const exportLimit = rateLimit({
  name: 'award-export',
  windowMs: 15 * 60_000,
  max: 60,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

/**
 * The PNG gets its own, tighter allowance on top of the one above.
 *
 * It is the only route here that can hold the event loop for more than a
 * moment, and only on a cache miss — which is exactly what a caller varying
 * `?size=` on every request produces. Twenty misses an hour is far more than
 * any real export session needs and is a bounded amount of CPU to hand one
 * account.
 */
const rasterLimit = rateLimit({
  name: 'award-badge-png',
  windowMs: 15 * 60_000,
  max: 20,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

const sendLimit = rateLimit({
  name: 'award-certificate-send',
  windowMs: 60 * 60_000,
  max: 30,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

/**
 * `candidate:read` and nothing narrower.
 *
 * These documents say what the candidate's journey page already shows to
 * whoever may open the candidate, so an export-only capability would leave the
 * same content behind two gates that could answer differently. Scope still
 * decides WHICH candidate. An auditor holds no `candidate:read` and so reaches
 * none of this, which is correct: audit sees that things happened, not who
 * they happened to.
 */
const mayRead = requireCapability('candidate:read');

// ------------------------------------------------------------- certificate

candidateAwardsRouter.get(
  '/:id/awards/:tier/certificate.pdf',
  mayRead,
  exportLimit,
  asyncHandler(async (req, res) => {
    const tier = readTier(req.params.tier);
    // Authorise before explaining. Diamond's refusal is the same sentence for
    // everyone, so it must not be reachable for a candidate the caller may not
    // see — otherwise the message itself confirms that the id is real.
    const award = await assertCanAccessAward(req.auth!, req.params.id, tier);
    if (!hasCertificate(tier)) throw new HttpError(409, NO_DIAMOND_CERTIFICATE, 'no_certificate_for_tier');

    const evidence = parseAwardEvidence(award.id, award.evidenceJson);
    const pdf = await certificatePdf({
      tier,
      reference: award.reference,
      verifyUrl: verifyDisplayUrl(award.verifyToken),
      issuedAt: award.awardedAt,
      evidence,
    });

    await logAudit({
      tenantId: req.auth!.tenantId,
      actorId: req.auth!.userId,
      actorType: 'user',
      action: 'candidate.award.certificate_exported',
      entityType: 'CandidateAward',
      entityId: award.id,
      after: { tier, reference: award.reference },
    });

    // Set only now that the bytes exist: a refusal above still leaves the
    // error handler free to answer JSON rather than a half-written attachment.
    res.type('application/pdf');
    res.set('Content-Disposition', `attachment; filename="${certificateFilename(award.reference, tier)}"`);
    res.send(pdf);
  }),
);

// ------------------------------------------------------------------ badges

/**
 * The badge exists only once the tier has been earned, so both of these need
 * an award row and answer 404 without one.
 *
 * Nothing is shown before it is earned — a candidate sitting at Bronze with a
 * finished Silver interview has no Silver badge — and an endpoint that drew
 * one on request would be the hole in that rule, as well as an unmetered image
 * generator behind a cheap capability.
 */
candidateAwardsRouter.get(
  '/:id/awards/:tier/badge.svg',
  mayRead,
  exportLimit,
  asyncHandler(async (req, res) => {
    const tier = readTier(req.params.tier);
    const award = await assertCanAccessAward(req.auth!, req.params.id, tier);
    const size = badgeSize(req.query.size);
    res.type('image/svg+xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${badgeFilename(award.reference, tier, 'svg')}"`);
    res.send(badgeSvg(tier, size));
  }),
);

candidateAwardsRouter.get(
  '/:id/awards/:tier/badge.png',
  mayRead,
  exportLimit,
  rasterLimit,
  asyncHandler(async (req, res) => {
    const tier = readTier(req.params.tier);
    const award = await assertCanAccessAward(req.auth!, req.params.id, tier);
    const size = badgeSize(req.query.size);
    res.type('image/png');
    res.set('Content-Disposition', `attachment; filename="${badgeFilename(award.reference, tier, 'png')}"`);
    res.send(badgePng(tier, size));
  }),
);

const DEFAULT_BADGE_PX = 512;

/** A doubling ladder from the smallest useful export to a printable one. */
const BADGE_SIZES: readonly number[] = [MIN_BADGE_PX, 64, 128, 256, DEFAULT_BADGE_PX, MAX_BADGE_PX];

/**
 * Snapped to a fixed ladder rather than taken at its word.
 *
 * Rasterising costs the square of this number and runs on the event loop, so
 * `?size=` is where a denial of service would be spelled — not by asking for
 * something enormous, which is clamped, but by asking for a slightly different
 * size every time and missing the cache on every request. Six sizes means at
 * most twenty-four renders can ever be asked for, after which every answer is
 * free.
 *
 * Snapped rather than refused because a number outside the ladder is somebody
 * building a page, not an attacker, and a badge is a fixed-size asset: getting
 * 256 when you asked for 300 is the answer you wanted.
 */
function badgeSize(raw: unknown): number {
  const asked = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_BADGE_PX;
  const wanted = Math.min(MAX_BADGE_PX, Math.max(MIN_BADGE_PX, asked));
  return BADGE_SIZES.reduce((best, size) => (Math.abs(size - wanted) < Math.abs(best - wanted) ? size : best));
}

// -------------------------------------------------------------------- send

/**
 * Sending a certificate to the candidate — an admin action, never automatic.
 *
 * Badges and certificates are the hiring team's record. Only written feedback
 * is emailed to a candidate on its own, and it is emailed by a different path
 * that asks their consent first. This one exists so that a tenant admin can
 * deliberately release a Silver or a Gold, and so that the act is attributable
 * afterwards: `sentByUserId` is who did it, `sentToCandidateAt` is when.
 *
 * `admin:manage`, not `assessment:export`: a hiring manager may take a copy of
 * this document, which is a private act inside the team, and may not decide
 * that the candidate now holds one, which is not.
 */
candidateAwardsRouter.post(
  '/:id/awards/:tier/certificate/send',
  requireCapability('admin:manage'),
  sendLimit,
  asyncHandler(async (req, res) => {
    const tier = readTier(req.params.tier);
    const award = await assertCanAccessAward(req.auth!, req.params.id, tier);
    if (!hasCertificate(tier)) throw new HttpError(409, NO_DIAMOND_CERTIFICATE, 'no_certificate_for_tier');
    if (tier === 'bronze') {
      throw new HttpError(
        409,
        'A Bronze certificate is held by the hiring team and is not issued to the candidate. It records an automated read of a CV, with no human assessment behind it.',
        'bronze_not_for_release',
      );
    }
    if (award.sentToCandidateAt) {
      throw new HttpError(409, 'This certificate has already been sent to the candidate.', 'already_sent');
    }

    const evidence = parseAwardEvidence(award.id, award.evidenceJson);
    const candidate = await prisma.candidate.findFirstOrThrow({
      where: { id: award.candidateId, tenantId: award.tenantId },
      select: { email: true },
    });

    const verifyUrl = verifyDisplayUrl(award.verifyToken);
    const subject = `Your Questor record of assessment — ${evidence.roleTitle}`;
    const text = [
      `Dear ${evidence.candidateName},`,
      '',
      `Your Questor ${tier} record of assessment for ${evidence.roleTitle} is available to view and download here:`,
      '',
      `https://${verifyUrl}`,
      '',
      `Reference ${award.reference}, issued ${issuedOn(award.awardedAt)}.`,
      '',
      'It is a record of the process you went through, not a recommendation.',
      '',
      'Questor',
    ].join('\n');

    // Claimed, then sent, and released again if the send does not happen.
    //
    // The `sentToCandidateAt` check above is a courtesy, not a guard: two
    // admins pressing the button at the same moment both read null, and both
    // would then email the candidate the same certificate. The claim below is
    // the guard, because `sentToCandidateAt: null` in its own where-clause
    // makes the write conditional — exactly one of the two requests changes a
    // row, and the other is told it has already gone.
    //
    // The tenant is in the where-clause too. The id came from a tenant-scoped
    // read a few lines up, so it changes nothing today; it means this write
    // cannot become a cross-tenant one if the route is ever refactored to take
    // an award id from the caller.
    const sentToCandidateAt = new Date();
    const claimed = await prisma.candidateAward.updateMany({
      where: { id: award.id, tenantId: req.auth!.tenantId, sentToCandidateAt: null },
      data: { sentToCandidateAt, sentByUserId: req.auth!.userId },
    });
    if (claimed.count === 0) {
      throw new HttpError(409, 'This certificate has already been sent to the candidate.', 'already_sent');
    }

    const provider = getEmail();
    try {
      await provider.send({ to: candidate.email, subject, text, html: `<pre>${escapeHtml(text)}</pre>` });
    } catch (err) {
      // Released, so that a provider that was down for a minute does not mark
      // the certificate sent for ever with no way to try again: the admin
      // would be told it went, the candidate would never see it, and every
      // retry would be refused. Conditional on the stamp this request wrote,
      // so it can never undo somebody else's successful send.
      const released = await prisma.candidateAward
        .updateMany({
          where: { id: award.id, tenantId: req.auth!.tenantId, sentToCandidateAt },
          data: { sentToCandidateAt: null, sentByUserId: null },
        })
        .catch(() => ({ count: 0 }));
      logger.error(
        { err, awardId: award.id, released: released.count },
        released.count === 1
          ? 'certificate send failed; the award was released so it can be retried'
          : 'certificate send failed AND could not be released — this award will refuse further sends until the row is corrected',
      );
      // The message tells the truth about the row, not a comforting version of
      // it. When the release did not happen the claim is still standing, so
      // "try again" would be an instruction that cannot work: the next attempt
      // meets the already-sent guard and is refused, and an admin left
      // retrying a dead button is how a candidate quietly never receives
      // anything.
      throw released.count === 1
        ? new HttpError(502, 'The certificate could not be sent. Nothing has been recorded — try again.', 'send_failed')
        : new HttpError(
            502,
            'The certificate could not be sent, and the attempt could not be cleared. This certificate will refuse further sends until support corrects the record.',
            'send_failed_not_released',
          );
    }

    await logAudit({
      tenantId: req.auth!.tenantId,
      actorId: req.auth!.userId,
      actorType: 'user',
      action: 'candidate.award.certificate_sent',
      entityType: 'CandidateAward',
      entityId: award.id,
      after: { tier, reference: award.reference },
    });

    res.json({ sentToCandidateAt, delivered: provider.delivers });
  }),
);

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Stored evidence that cannot be rendered is a 500, not a 404.
 *
 * The award exists and the caller is entitled to it; what is wrong is our own
 * row. Saying "not found" would send a recruiter looking for a candidate who
 * is plainly on their screen, and would bury a data fault nobody then fixes.
 */
candidateAwardsRouter.use((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
  if (err instanceof AwardEvidenceError) {
    logger.error({ err, awardId: err.awardId }, 'award evidence cannot be rendered');
    next(new HttpError(500, 'This certificate cannot be produced because its stored record is incomplete. Support has been notified.', 'award_evidence_corrupt'));
    return;
  }
  next(err);
});
>>>>>>> 160ba8f (feat(cert): export and send a candidate's credential)
