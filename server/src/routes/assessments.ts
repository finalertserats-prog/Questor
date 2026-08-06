import { Router } from 'express';
import { z } from 'zod';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import type { AssessmentResult } from '../domain/types.js';
import { renderReportMarkdown } from '../engines/reportWriter.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';
import { getAts } from '../providers/ats/index.js';
import { assertCanAccessAssessment, hasCapability, ranTheInterview } from '../services/access.js';
import {
  assertBlindVerdictRecorded, assertUnblindedReadAllowed, getAgreementReport, getBlindView,
  recordBlindVerdict, BLIND_BYPASS_ACTION, DISPOSITIONS, SELF_REVIEW_NOTE,
} from '../services/shadowMode.js';

export const assessmentsRouter = Router();
assessmentsRouter.use(authenticate);

/**
 * Every route below loads its assessment through object scope, not a tenant
 * match. The previous tenant-only loader meant any authenticated user could
 * read, override and export any candidate's assessment in the org.
 */
const getAssessment = assertCanAccessAssessment;

// ---------------------------------------------------------------------------
// Shadow mode (see services/shadowMode.ts and docs/VALIDATION.md)
//
// Route order matters: these literal paths MUST be declared before '/:id',
// otherwise Express matches '/shadow-metrics' as an assessment id and the
// metrics endpoint 404s.
// ---------------------------------------------------------------------------

// Scoring-validity metrics across the tenant. Deliberately readable by any
// authenticated user: a reviewer being asked to trust the AI's score is
// entitled to see whether that score has ever been shown to agree with anyone.
assessmentsRouter.get('/shadow-metrics', asyncHandler(async (req, res) => {
  const report = await getAgreementReport(req.auth!.tenantId);
  res.json(report);
}));

// The blinded assessment: evidence, transcript and competency definitions, with
// every AI conclusion withheld so the reviewer forms an independent judgement.
assessmentsRouter.get('/:id/blind', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  // Gated on assessment:review rather than assessment:read: the blind view is
  // the reviewer's working surface, and its whole purpose is to be seen only by
  // someone who is about to file an independent verdict.
  const view = await getBlindView(req.auth!, req.params.id);
  res.json(view);
}));

const blindVerdictSchema = z.object({
  disposition: z.enum(DISPOSITIONS),
  reason: z.string().min(3),
  comments: z.string().optional(),
  competencyLevels: z.array(z.object({
    competencyId: z.string().min(1),
    level: z.number().int().min(1).max(5),
    reason: z.string().optional(),
  })).default([]),
});

assessmentsRouter.post('/:id/blind-verdict', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const body = blindVerdictSchema.parse(req.body);
  // recordBlindVerdict resolves the reviewer from the caller's own claims and
  // records — without blocking — whether they drove this interview themselves.
  const { reviewId, recordedAt, selfReview } = await recordBlindVerdict(req.auth!, req.params.id, body);
  // Audited because the ORDER of these events is the compliance artefact: it is
  // what shows the human judgement preceded, rather than echoed, the machine's.
  // selfReview rides along so a later audit can find non-independent reviews
  // without reparsing every comments field.
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.blind_verdict',
    entityType: 'AssessmentVersion', entityId: req.params.id,
    after: { reviewId, disposition: body.disposition, competencyCount: body.competencyLevels.length, recordedAt, selfReview },
  });
  res.status(201).json({ reviewId, recordedAt, selfReview, revealUrl: `/api/assessments/${req.params.id}/reveal` });
}));

// Reveal — refuses until this reviewer has recorded their own verdict.
assessmentsRouter.get('/:id/reveal', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  await assertBlindVerdictRecorded(a.id, req.auth!.userId);
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.ai_revealed',
    entityType: 'AssessmentVersion', entityId: a.id, after: { recommendation: a.recommendation },
  });
  res.json({
    id: a.id,
    result: parseJson<AssessmentResult>(a.resultJson, {} as AssessmentResult),
    note: 'Advisory only. Agreement between this output and blind human review has not been established — '
      + 'see GET /api/assessments/shadow-metrics and docs/VALIDATION.md.',
  });
}));

assessmentsRouter.get('/:id', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  // Blind-first is enforced here, not just offered in the UI. Otherwise a
  // reviewer reaches the score by typing the URL, and the independence that
  // keeps this advisory rather than automated is lost without anyone noticing.
  await assertUnblindedReadAllowed({
    assessmentId: a.id, userId: req.auth!.userId, canReview: hasCapability(req.auth!, 'assessment:review'),
  });
  const reviews = await prisma.humanReview.findMany({ where: { assessmentId: a.id }, orderBy: { createdAt: 'desc' } });
  res.json({
    id: a.id,
    sessionId: a.sessionId,
    candidate: { id: a.session.candidateId, name: a.session.candidate.fullName },
    role: { id: a.session.roleId, title: a.session.role.title },
    result: parseJson<AssessmentResult>(a.resultJson, {} as AssessmentResult),
    reviews: reviews.map((r) => ({ id: r.id, status: r.status, disposition: r.disposition, reason: r.reason, overrides: parseJson(r.overridesJson, []), completedAt: r.completedAt })),
  });
}));

assessmentsRouter.get('/:id/report', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  // The report is the same conclusions in prose — gating /:id but not this would
  // leave the front door locked and the back door open.
  await assertUnblindedReadAllowed({
    assessmentId: a.id, userId: req.auth!.userId, canReview: hasCapability(req.auth!, 'assessment:review'),
  });
  const result = parseJson<AssessmentResult>(a.resultJson, {} as AssessmentResult);
  const md = renderReportMarkdown({ candidateName: a.session.candidate.fullName, roleTitle: a.session.role.title, assessment: result });
  if (req.query.format === 'json') return res.json({ report: md, result });
  res.type('text/markdown').send(md);
}));

/**
 * Break glass: open the assessment without recording a blind verdict first.
 *
 * A lock with no escape does not produce blind reviews — it produces a shared
 * admin login, which costs the audit trail as well as the independence. There
 * are legitimate reasons to skip (re-reading a candidate you already decided on
 * elsewhere, a compliance check, debugging a bad report), so the escape exists.
 *
 * What it does NOT do is happen quietly: it demands a reason, records it against
 * the user, and surfaces in shadow-metrics as a review that skipped blinding, so
 * a team that bypasses habitually is visible rather than assumed compliant.
 */
assessmentsRouter.post('/:id/skip-blind-review', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(10, 'Give a real reason (at least 10 characters).') }).parse(req.body);
  const a = await getAssessment(req.auth!, req.params.id);
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user',
    action: BLIND_BYPASS_ACTION, entityType: 'AssessmentVersion', entityId: a.id,
    after: { reason },
  });
  res.status(201).json({ ok: true, bypassed: true });
}));

// Human review / override (FR-033)
const reviewSchema = z.object({
  disposition: z.enum(['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS']),
  reason: z.string().min(3),
  comments: z.string().optional(),
  overrides: z.array(z.object({ competencyId: z.string(), from: z.any(), to: z.any(), reason: z.string() })).default([]),
});
assessmentsRouter.post('/:id/review', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  const body = reviewSchema.parse(req.body);

  // Separation of duties, recorded rather than enforced.
  //
  // A reviewer signing off the interview they personally drove is the weakest
  // form of the "meaningful human review" that keeps this pipeline advisory
  // under GDPR Art. 22 and NYC LL144. It is NOT hard-blocked: a small recruiting
  // team may genuinely have nobody else available, and a 403 here does not
  // conjure an independent reviewer — it pushes the work onto a shared admin
  // login, which costs us the audit trail as well as the independence. Stamping
  // it on the review row and the audit event makes the missing independence
  // visible in the compliance record instead of absent from it.
  const selfReview = await ranTheInterview(req.auth!.userId, a.sessionId);
  const comments = body.comments ?? '';
  const review = await prisma.humanReview.create({
    data: {
      assessmentId: a.id, reviewerId: req.auth!.userId, status: 'COMPLETED', disposition: body.disposition,
      reason: body.reason,
      comments: selfReview ? (comments ? `${comments}\n\n${SELF_REVIEW_NOTE}` : SELF_REVIEW_NOTE) : comments,
      overridesJson: JSON.stringify(body.overrides), completedAt: new Date(),
    },
  });
  // Session -> HUMAN_REVIEWED -> CLOSED
  if (a.session.state === 'REVIEW_READY') {
    await prisma.interviewSession.update({ where: { id: a.sessionId }, data: { state: 'HUMAN_REVIEWED' } });
  }
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.completed',
    entityType: 'AssessmentVersion', entityId: a.id,
    before: { recommendation: a.recommendation },
    after: { disposition: body.disposition, reason: body.reason, selfReview },
  });
  await emitEvent(req.auth!.tenantId, 'review.completed', { assessmentId: a.id, disposition: body.disposition });
  res.status(201).json({ review: { id: review.id, disposition: review.disposition, selfReview } });
}));

// Export to ATS (FR-040)
assessmentsRouter.post('/:id/export', requireCapability('assessment:export'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  const result = parseJson<AssessmentResult>(a.resultJson, {} as AssessmentResult);
  const externalId = (req.body?.externalCandidateId as string) || a.session.candidateId;
  const out = await getAts().pushAssessment(externalId, {
    candidate: a.session.candidate.fullName, role: a.session.role.title,
    recommendation: result.recommendation, confidence: result.confidence, overallScore: result.overallScore,
    competencies: result.competencies.map((c) => ({ name: c.name, level: c.level })),
  });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'assessment.exported', entityType: 'AssessmentVersion', entityId: a.id, after: out });
  res.json(out);
}));
